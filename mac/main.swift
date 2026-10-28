// B5 Code's Mac app: one native window that shows B5 Code's page.
//
// It starts B5 Code's server if it isn't running (through bin/b5, which knows
// the PATH and the log), then loads the page in a WKWebView, the same WebKit
// Safari uses. Closing the window quits the app but leaves the server
// running, so a job Claude is doing carries on and is there when you reopen.
//
// The page talks back through one message handler, "desk", to post Mac
// notifications ("A thread finished", "Claude is asking").

import Cocoa
import WebKit
import UserNotifications
import Speech
import AVFoundation

let deskDir = (Bundle.main.object(forInfoDictionaryKey: "DeskDir") as? String) ?? (NSHomeDirectory() + "/Desktop/b5code")
let port = (Bundle.main.object(forInfoDictionaryKey: "DeskPort") as? String) ?? "4317"
let deskURL = URL(string: "http://localhost:\(port)/")!

// The title bar is hidden, so the page's own top bar is where you drag the
// window. The page sends the rectangles that may drag (its bars) and the ones
// inside them that are buttons; a click in a drag area moves the window, a
// double-click zooms it, anything else goes to the page as usual.
final class DeskWebView: WKWebView {
    var dragRects: [NSRect] = []
    var noDragRects: [NSRect] = []

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let top = isFlipped ? p.y : bounds.height - p.y
        let pt = NSPoint(x: p.x / pageZoom, y: top / pageZoom)
        if dragRects.contains(where: { $0.contains(pt) }) && !noDragRects.contains(where: { $0.contains(pt) }) {
            if event.clickCount == 2 { window?.performZoom(nil) } else { window?.performDrag(with: event) }
            return
        }
        super.mouseDown(with: event)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var web: DeskWebView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "desk")
        // What this build of the app can do, so the page never sends a request
        // an older app would silently ignore (it falls back to its own way).
        config.userContentController.addUserScript(WKUserScript(
            source: "window.deskFeatures = ['pickFolder', 'sound', 'notifyStatus'];",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.websiteDataStore = .default()
        web = DeskWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground") // the sidebar shows the vibrancy behind it

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "B5 Code"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.delegate = self
        window.minSize = NSSize(width: 420, height: 480)

        let vibrancy = NSVisualEffectView()
        vibrancy.material = .sidebar
        vibrancy.blendingMode = .behindWindow
        vibrancy.state = .followsWindowActiveState
        window.contentView = vibrancy
        web.frame = vibrancy.bounds
        web.autoresizingMask = [.width, .height]
        vibrancy.addSubview(web)
        window.center()
        window.setFrameAutosaveName("DeskMainWindow")
        window.makeKeyAndOrderFront(nil)
        placeWindowButtons()
        NSApp.activate(ignoringOtherApps: true)

        UNUserNotificationCenter.current().delegate = self
        // Asked at launch, so B5 Code is in System Preferences › Notifications from the start.
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        watchClipboard()
        showMessage("Starting B5 Code…")
        startServerThenLoad()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // The window buttons, centred in the page's 38px top bar. AppKit puts them
    // back after a resize, so they are placed again each time.
    let chrome: CGFloat = 38
    func placeWindowButtons() {
        guard let close = window.standardWindowButton(.closeButton), let bar = close.superview else { return }
        for (i, type) in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].enumerated() {
            guard let b = window.standardWindowButton(type) else { continue }
            let y = bar.frame.height - chrome / 2 - b.frame.height / 2
            b.setFrameOrigin(NSPoint(x: 16 + CGFloat(i) * 20, y: bar.isFlipped ? chrome / 2 - b.frame.height / 2 : y))
        }
    }
    func windowDidResize(_ notification: Notification) { placeWindowButtons() }
    func windowDidExitFullScreen(_ notification: Notification) { placeWindowButtons() }
    func windowDidBecomeKey(_ notification: Notification) { placeWindowButtons() }

    // MARK: Server

    func serverIsUp(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: deskURL, timeoutInterval: 1)
        req.httpMethod = "HEAD"
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            done((resp as? HTTPURLResponse) != nil)
        }.resume()
    }

    func startServerThenLoad() {
        serverIsUp { up in
            if up { DispatchQueue.main.async { self.web.load(URLRequest(url: deskURL)) }; return }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = [deskDir + "/bin/b5", "--no-open"]
            p.terminationHandler = { proc in
                DispatchQueue.main.async {
                    if proc.terminationStatus == 0 {
                        self.web.load(URLRequest(url: deskURL))
                    } else {
                        self.showMessage("B5 Code couldn't start. The reason is in b5code/data/b5.log.", retry: true)
                    }
                }
            }
            do { try p.run() } catch {
                // This runs on URLSession's queue; the web view only on the main thread.
                DispatchQueue.main.async { self.showMessage("B5 Code couldn't start: \(error.localizedDescription)", retry: true) }
            }
        }
    }

    func showMessage(_ text: String, retry: Bool = false) {
        let button = retry ? "<p><a href=\"desk-retry:\">Try again</a></p>" : ""
        let html = """
        <html><head><meta name="color-scheme" content="light dark"><style>
        body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
        font:15px -apple-system,system-ui,sans-serif;color:#5d6470;background:#f4f5f7}
        @media (prefers-color-scheme: dark){body{background:#111318;color:#9aa3b2}}
        a{color:#4f46e5;font-weight:600}</style></head>
        <body><div style="text-align:center"><p>\(text)</p>\(button)</div></body></html>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    // MARK: Navigation: B5 Code and Preview's frame stay inside, other links leave for the browser

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == "desk-retry" {
            showMessage("Starting B5 Code…")
            startServerThenLoad()
            return decisionHandler(.cancel)
        }
        // B5 Code's page, and the preview server on the next port up.
        let isDesk = (url.host == "localhost" || url.host == "127.0.0.1") && (url.port == Int(port) || url.port == (Int(port) ?? 0) + 1)
        // Inside Preview's frame, a page (localhost:3000, a site) loads in place: the frame is the browser there.
        let inFrame = action.targetFrame.map { !$0.isMainFrame } ?? false
        if isDesk || inFrame || url.scheme == "about" || action.navigationType == .other && url.host == nil {
            return decisionHandler(.allow)
        }
        openOutside(url)
        decisionHandler(.cancel)
    }

    // Links leave B5 Code for the browser or Mail only. A page in Preview could offer a file:// link to
    // a .command or an app, or another app's own scheme: macOS would run it, so those are dropped.
    func openOutside(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else { return }
        NSWorkspace.shared.open(url)
    }

    // <input type="file"> (the + menu's "Add photos & files")
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.prompt = "Add"
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }

    // target="_blank" links
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { openOutside(url) }
        return nil
    }

    // The server went away (Mac slept, `b5 stop`): bring it back.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // One load replacing another (a reload during a load) is not the server going away.
        if (error as NSError).domain == NSURLErrorDomain && (error as NSError).code == NSURLErrorCancelled { return }
        showMessage("Reconnecting to B5 Code…")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.startServerThenLoad() }
    }

    // MARK: Messages from the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only B5 Code's own page talks to the app: never a previewed page in
        // its frame (which could switch on the microphone or post notifications).
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.host == "localhost" || origin.host == "127.0.0.1", origin.port == Int(port) else { return }
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        if type == "theme" {
            let v = body["value"] as? String
            NSApp.appearance = v == "dark" ? NSAppearance(named: .darkAqua) : v == "light" ? NSAppearance(named: .aqua) : nil
            return
        }
        if type == "zoom", let z = body["value"] as? Double {
            web.pageZoom = CGFloat(max(0.7, min(z, 1.6)))
            return
        }
        // "Add a project": Finder's folder picker, answered into the dialog.
        if type == "pickFolder" {
            let panel = NSOpenPanel()
            panel.title = "Choose a project folder"
            panel.prompt = "Choose"
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.canCreateDirectories = true
            panel.allowsMultipleSelection = false
            panel.directoryURL = URL(fileURLWithPath: NSHomeDirectory() + "/Desktop")
            panel.beginSheetModal(for: window) { response in
                guard response == .OK, let url = panel.url,
                      let data = try? JSONSerialization.data(withJSONObject: [url.path]),
                      let json = String(data: data, encoding: .utf8) else { return }
                self.web.evaluateJavaScript("window.deskPickedFolder && window.deskPickedFolder(\(json)[0])", completionHandler: nil)
            }
            return
        }
        if type == "pickFile" {
            let panel = NSOpenPanel()
            panel.title = "Open a file to preview"
            panel.prompt = "Preview"
            panel.canChooseFiles = true
            panel.canChooseDirectories = false
            panel.allowsMultipleSelection = false
            panel.directoryURL = URL(fileURLWithPath: NSHomeDirectory() + "/Desktop")
            panel.beginSheetModal(for: window) { response in
                guard response == .OK, let url = panel.url,
                      let data = try? JSONSerialization.data(withJSONObject: [url.path]),
                      let json = String(data: data, encoding: .utf8) else { return }
                self.web.evaluateJavaScript("window.deskOpenPreview && window.deskOpenPreview(\(json)[0])", completionHandler: nil)
            }
            return
        }
        if type == "dictate" {
            if (body["action"] as? String) == "start" { startDictation() } else { stopDictation(final: true) }
            return
        }
        if type == "regions" {
            func rects(_ key: String) -> [NSRect] {
                ((body[key] as? [[Double]]) ?? []).compactMap { $0.count == 4 ? NSRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) : nil }
            }
            web.dragRects = rects("drag")
            web.noDragRects = rects("noDrag")
            return
        }
        // One of the Mac's own sounds (Ping, Glass, …), played by B5 Code itself, so you hear it
        // whatever macOS allows its notifications.
        if type == "sound" {
            let name = (body["name"] as? String) ?? ""
            if Self.sounds.contains(name) { NSSound(named: NSSound.Name(name))?.play() }
            return
        }
        // Whether macOS lets B5 Code show notifications, for Settings.
        if type == "notifyStatus" {
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                let status: String
                switch settings.authorizationStatus {
                case .authorized, .provisional: status = settings.alertSetting == .enabled ? "on" : "quiet"
                case .denied: status = "off"
                default: status = "unasked"
                }
                DispatchQueue.main.async { self.web.evaluateJavaScript("window.deskNotifyStatus && window.deskNotifyStatus('\(status)')", completionHandler: nil) }
            }
            return
        }
        if type == "openNotificationSettings" {
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.notifications")!)
            return
        }
        guard type == "notify" else { return }
        let title = (body["title"] as? String) ?? "B5 Code"
        let text = (body["body"] as? String) ?? ""
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in
            guard ok else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = text
            content.sound = nil // the page plays the sound you picked
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }

    static let sounds: Set<String> = ["Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"]

    // A notification sent while B5 Code is in front (Settings' test) still shows as a banner.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list])
    }

    // Clicking a notification brings B5 Code to the front.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        done()
    }

    // MARK: Plan answers from the clipboard
    // A plan page's "Copy my answers" puts a block starting "PLAN ANSWERS" on
    // the clipboard. While B5 Code is in front, a new block like that is
    // offered to the page, which asks before putting it in the message.

    var pasteboardCount = NSPasteboard.general.changeCount
    func watchClipboard() {
        Timer.scheduledTimer(withTimeInterval: 0.7, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            let pb = NSPasteboard.general
            guard pb.changeCount != self.pasteboardCount else { return }
            self.pasteboardCount = pb.changeCount
            guard NSApp.isActive, let text = pb.string(forType: .string),
                  text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("PLAN ANSWERS"),
                  let data = try? JSONSerialization.data(withJSONObject: [text]),
                  let json = String(data: data, encoding: .utf8) else { return }
            self.web.evaluateJavaScript("window.deskPlanAnswers && window.deskPlanAnswers(\(json)[0])", completionHandler: nil)
        }
    }

    // MARK: Dictation (Apple's speech recognition, on this Mac when it can)

    let audio = AVAudioEngine()
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?

    func toPage(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.deskDictation && window.deskDictation(\(json))", completionHandler: nil)
    }

    func startDictation() {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else {
                    self.toPage(["state": "error", "message": "Speech recognition is off for B5 Code. Turn it on in System Preferences › Security & Privacy › Privacy › Speech Recognition."])
                    return
                }
                AVCaptureDevice.requestAccess(for: .audio) { ok in
                    DispatchQueue.main.async {
                        if ok { self.beginListening() } else {
                            self.toPage(["state": "error", "message": "B5 Code can't use the microphone. Allow it in System Preferences › Security & Privacy › Privacy › Microphone."])
                        }
                    }
                }
            }
        }
    }

    func beginListening() {
        stopDictation(final: false)
        let lang = Locale.preferredLanguages.first ?? "en-US"
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang)) ?? SFSpeechRecognizer(), recognizer.isAvailable else {
            toPage(["state": "error", "message": "Speech recognition isn't available right now."])
            return
        }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        request = req
        let input = audio.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in req.append(buffer) }
        audio.prepare()
        do { try audio.start() } catch {
            toPage(["state": "error", "message": "The microphone didn't start: \(error.localizedDescription)"])
            return
        }
        task = recognizer.recognitionTask(with: req) { result, error in
            DispatchQueue.main.async {
                if let r = result { self.toPage(["text": r.bestTranscription.formattedString, "state": r.isFinal ? "stopped" : "listening"]) }
                if error != nil || (result?.isFinal ?? false) { self.stopDictation(final: false); self.toPage(["state": "stopped"]) }
            }
        }
    }

    func stopDictation(final: Bool) {
        if audio.isRunning { audio.stop(); audio.inputNode.removeTap(onBus: 0) }
        request?.endAudio()
        if final { task?.finish() } else { task?.cancel() }
        request = nil
        task = nil
    }

    // MARK: Menu bar (Edit is what makes copy, paste and undo work in the page)

    func buildMenu() {
        let main = NSMenu()

        let app = NSMenu()
        app.addItem(withTitle: "About B5 Code", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide B5 Code", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit B5 Code", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        main.addItem(withTitle: "B5 Code", action: nil, keyEquivalent: "").submenu = app

        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        main.addItem(withTitle: "Edit", action: nil, keyEquivalent: "").submenu = edit

        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Toggle Sidebar", action: #selector(toggleSidebar), keyEquivalent: "\\")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "Actual Size", action: #selector(zoomReset), keyEquivalent: "0")
        view.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "+")
        view.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        view.addItem(.separator())
        let fs = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        main.addItem(withTitle: "View", action: nil, keyEquivalent: "").submenu = view

        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        main.addItem(withTitle: "Window", action: nil, keyEquivalent: "").submenu = win
        NSApp.windowsMenu = win

        NSApp.mainMenu = main
    }

    @objc func reload() { startServerThenLoad() }
    @objc func toggleSidebar() { web.evaluateJavaScript("window.deskToggleSidebar && window.deskToggleSidebar()", completionHandler: nil) }
    @objc func openSettings() { web.evaluateJavaScript("window.deskSettings && window.deskSettings()", completionHandler: nil) }
    @objc func zoomIn() { web.pageZoom = min(web.pageZoom + 0.1, 2.0) }
    @objc func zoomOut() { web.pageZoom = max(web.pageZoom - 0.1, 0.6) }
    @objc func zoomReset() { web.pageZoom = 1.0 }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
