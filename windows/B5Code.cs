// B5 Code's Windows app: one window that shows B5 Code's page, as mac/main.swift
// does on the Mac.
//
// It starts B5 Code's server if it isn't running (through bin/b5.mjs, which
// knows the log), then loads the page in WebView2, the Edge engine Windows
// has built in. Closing the window leaves the server running, so a job
// Claude is doing carries on and is there when you reopen. With --background
// (the Startup folder's shortcut) it only starts the server.
//
// The page talks back through chrome.webview.postMessage, the same messages
// the Mac app takes: notifications, the folder and file pickers, the theme
// and text size. Only B5 Code's own page is listened to, never a previewed
// page in its frame.
//
// windows/build.mjs compiles it with the C# compiler .NET Framework puts on
// every Windows PC (C# 5: no string interpolation, no ?.), against Microsoft's
// WebView2 package.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        // windows\bin\B5Code.exe: B5 Code's folder is two up.
        string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
        string port = Environment.GetEnvironmentVariable("B5_PORT");
        if (string.IsNullOrEmpty(port)) port = "4317";
        if (Array.IndexOf(args, "--background") >= 0) return Server.EnsureRunning(root, port) ? 0 : 1;

        // One window: opening B5 Code again brings it to the front.
        bool first;
        using (var only = new Mutex(true, "Local\\B5Code.Window", out first))
        {
            if (!first) { Native.ShowOther(); return 0; }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm(root, port));
        }
        return 0;
    }
}

static class Server
{
    public static bool IsUp(string port)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/");
            req.Method = "HEAD";
            req.Timeout = 1000;
            req.Proxy = null;
            using (req.GetResponse()) { }
            return true;
        }
        catch (WebException e) { return e.Response != null; } // any answer means it's up
        catch { return false; }
    }

    /** node.exe: on the PATH, or where Node's installer puts it. */
    public static string Node()
    {
        var places = new List<string>();
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
            if (dir.Trim().Length > 0) places.Add(Path.Combine(dir.Trim().Trim('"'), "node.exe"));
        places.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"));
        string nvm = Environment.GetEnvironmentVariable("NVM_SYMLINK");
        if (!string.IsNullOrEmpty(nvm)) places.Add(Path.Combine(nvm, "node.exe"));
        foreach (var p in places) { try { if (File.Exists(p)) return p; } catch { } }
        return null;
    }

    /** Starts the server (bin/b5.mjs --no-open) unless it's up; true once it answers. */
    public static bool EnsureRunning(string root, string port)
    {
        if (IsUp(port)) return true;
        string node = Node();
        if (node == null) return false;
        var info = new ProcessStartInfo(node, "\"" + Path.Combine(root, "bin", "b5.mjs") + "\" --no-open");
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.WorkingDirectory = root;
        try
        {
            using (var p = Process.Start(info))
            {
                if (!p.WaitForExit(180000)) return false; // an update holds the start for a while
                return p.ExitCode == 0;
            }
        }
        catch { return false; }
    }
}

sealed class MainForm : Form
{
    readonly string root, port, deskUrl;
    readonly WebView2 web = new WebView2();
    readonly NotifyIcon tray = new NotifyIcon();
    readonly System.Windows.Forms.Timer clipboard = new System.Windows.Forms.Timer();
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    uint clipboardSeen = Native.GetClipboardSequenceNumber();
    string theme = "system";
    bool ready;

    static string AppData { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "B5 Code"); } }
    static string BoundsFile { get { return Path.Combine(AppData, "window.txt"); } }

    public MainForm(string root, string port)
    {
        this.root = root;
        this.port = port;
        deskUrl = "http://localhost:" + port + "/";
        Text = "B5 Code";
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        MinimumSize = new Size(420, 480);
        Size = new Size(1280, 820);
        StartPosition = FormStartPosition.CenterScreen;
        LoadBounds();
        BackColor = Native.DarkNow("system") ? Color.FromArgb(17, 19, 24) : Color.FromArgb(244, 245, 247);
        web.Dock = DockStyle.Fill;
        web.DefaultBackgroundColor = BackColor;
        Controls.Add(web);

        tray.Icon = Icon;
        tray.Text = "B5 Code";
        tray.Visible = true;
        tray.Click += delegate { BringForward(); };
        tray.BalloonTipClicked += delegate { BringForward(); };

        clipboard.Interval = 700;
        clipboard.Tick += delegate { WatchClipboard(); };
        clipboard.Start();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Native.DarkTitleBar(Handle, Native.DarkNow(theme));
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(AppData, "WebView2"));
            await web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            if (MessageBox.Show(this, "B5 Code needs Microsoft Edge WebView2, which this PC doesn't have. Get it from Microsoft now?", "B5 Code", MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes)
                OpenOutside("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
            Close();
            return;
        }
        var core = web.CoreWebView2;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = true;
        // What this build of the app can do, so the page never sends what it would ignore. Only on
        // B5 Code's own page: a previewed page in its frame gets nothing.
        await core.AddScriptToExecuteOnDocumentCreatedAsync(
            "if (window.top === window && location.origin === " + json.Serialize("http://localhost:" + port) + ") { window.deskWindows = true; window.deskFeatures = ['pickFolder', 'pickFile']; }");
        core.WebMessageReceived += OnMessage;
        core.NavigationStarting += OnNavigationStarting;
        core.NewWindowRequested += delegate (object s, CoreWebView2NewWindowRequestedEventArgs a) { a.Handled = true; OpenOutside(a.Uri); };
        core.NavigationCompleted += OnNavigationCompleted;
        core.ProcessFailed += delegate { StartServerThenLoad(); };
        ready = true;
        ShowMessage("Starting B5 Code…", false);
        StartServerThenLoad();
    }

    // ── Server ──────────────────────────────────────────────────────────────

    void StartServerThenLoad()
    {
        Task.Run(() => Server.EnsureRunning(root, port)).ContinueWith(t => BeginInvoke((Action)(() =>
        {
            if (t.Result) web.CoreWebView2.Navigate(deskUrl);
            else if (Server.Node() == null) ShowMessage("B5 Code needs Node.js, which isn't on this PC. Install it from nodejs.org, then try again.", true);
            else ShowMessage("B5 Code couldn't start. The reason is in b5code\\data\\b5.log.", true);
        })));
    }

    void ShowMessage(string text, bool retry)
    {
        if (!ready) return;
        string dark = Native.DarkNow(theme) ? "background:#111318;color:#9aa3b2" : "background:#f4f5f7;color:#5d6470";
        string button = retry ? "<p><a href=\"desk-retry:\">Try again</a></p>" : "";
        web.CoreWebView2.NavigateToString("<html><head><meta charset=\"utf-8\"><style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:15px 'Segoe UI',system-ui,sans-serif;" + dark + "}a{color:#6366f1;font-weight:600}</style></head><body><div style=\"text-align:center\"><p>"
            + WebUtility.HtmlEncode(text) + "</p>" + button + "</div></body></html>");
    }

    // ── Navigation: B5 Code and Preview's frame stay inside, other links leave for the browser ──

    bool IsDesk(Uri u)
    {
        int p;
        if (!int.TryParse(port, out p)) return false;
        return (u.Scheme == "http") && (u.Host == "localhost" || u.Host == "127.0.0.1") && (u.Port == p || u.Port == p + 1);
    }

    void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (e.Uri.StartsWith("desk-retry:")) { e.Cancel = true; ShowMessage("Starting B5 Code…", false); StartServerThenLoad(); return; }
        if (e.Uri.StartsWith("about:") || e.Uri.StartsWith("data:")) return; // our own messages
        Uri u;
        if (Uri.TryCreate(e.Uri, UriKind.Absolute, out u) && IsDesk(u)) return;
        e.Cancel = true;
        OpenOutside(e.Uri);
    }

    // The server went away (the PC slept, `b5 stop`): bring it back.
    void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (e.IsSuccess || e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled) return;
        Uri u;
        if (!Uri.TryCreate(web.CoreWebView2.Source, UriKind.Absolute, out u) || !IsDesk(u)) return;
        ShowMessage("Reconnecting to B5 Code…", false);
        var later = new System.Windows.Forms.Timer();
        later.Interval = 1000;
        later.Tick += delegate { later.Stop(); later.Dispose(); StartServerThenLoad(); };
        later.Start();
    }

    // Links leave B5 Code for the browser or mail only: a page in Preview could offer a file:// link
    // to a program, or another app's own scheme, which Windows would run.
    static void OpenOutside(string url)
    {
        Uri u;
        if (!Uri.TryCreate(url, UriKind.Absolute, out u)) return;
        if (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "mailto") return;
        try { Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); } catch { }
    }

    // ── Messages from the page ──────────────────────────────────────────────

    void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        Uri from;
        if (!Uri.TryCreate(e.Source, UriKind.Absolute, out from) || !IsDesk(from) || from.Port.ToString() != port) return;
        Dictionary<string, object> body;
        try { body = json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson); } catch { return; }
        if (body == null || !body.ContainsKey("type")) return;
        string type = body["type"] as string;
        if (type == "theme")
        {
            theme = (body.ContainsKey("value") ? body["value"] as string : null) ?? "system";
            Native.DarkTitleBar(Handle, Native.DarkNow(theme));
        }
        else if (type == "zoom" && body.ContainsKey("value"))
        {
            double z;
            if (double.TryParse(Convert.ToString(body["value"], System.Globalization.CultureInfo.InvariantCulture), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out z))
                web.ZoomFactor = Math.Max(0.7, Math.Min(z, 1.6));
        }
        else if (type == "pickFolder")
        {
            string dir = Native.PickFolder(Handle, "Choose a project folder", Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));
            if (dir != null) web.CoreWebView2.ExecuteScriptAsync("window.deskPickedFolder && window.deskPickedFolder(" + json.Serialize(dir) + ")");
        }
        else if (type == "pickFile")
        {
            using (var d = new OpenFileDialog())
            {
                d.Title = "Open a file to preview";
                d.InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                if (d.ShowDialog(this) == DialogResult.OK) web.CoreWebView2.ExecuteScriptAsync("window.deskOpenPreview && window.deskOpenPreview(" + json.Serialize(d.FileName) + ")");
            }
        }
        else if (type == "notify")
        {
            string title = (body.ContainsKey("title") ? body["title"] as string : null) ?? "B5 Code";
            string text = (body.ContainsKey("body") ? body["body"] as string : null) ?? "";
            tray.ShowBalloonTip(5000, title, text.Length > 0 ? text : " ", ToolTipIcon.None);
        }
    }

    void BringForward()
    {
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Show();
        Activate();
    }

    // ── Plan answers from the clipboard ─────────────────────────────────────
    // A plan page's "Copy my answers" puts a block starting "PLAN ANSWERS" on the clipboard. While
    // B5 Code is in front, a new block like that is offered to the page, which asks before using it.

    void WatchClipboard()
    {
        uint n = Native.GetClipboardSequenceNumber();
        if (n == clipboardSeen) return;
        clipboardSeen = n;
        if (!ready || Form.ActiveForm != this) return;
        string text;
        try { text = Clipboard.ContainsText() ? Clipboard.GetText() : null; } catch { return; }
        if (text == null || !text.TrimStart().StartsWith("PLAN ANSWERS")) return;
        web.CoreWebView2.ExecuteScriptAsync("window.deskPlanAnswers && window.deskPlanAnswers(" + json.Serialize(text) + ")");
    }

    // ── The window's place, kept between runs ───────────────────────────────

    void LoadBounds()
    {
        try
        {
            var p = File.ReadAllText(BoundsFile).Split(',');
            var r = new Rectangle(int.Parse(p[0]), int.Parse(p[1]), int.Parse(p[2]), int.Parse(p[3]));
            // Only somewhere still on a screen (a monitor may have gone).
            foreach (var s in Screen.AllScreens)
            {
                if (!s.WorkingArea.IntersectsWith(r)) continue;
                StartPosition = FormStartPosition.Manual;
                Bounds = r;
                if (p.Length > 4 && p[4] == "max") WindowState = FormWindowState.Maximized;
                return;
            }
        }
        catch { }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        try
        {
            Directory.CreateDirectory(AppData);
            var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            File.WriteAllText(BoundsFile, r.X + "," + r.Y + "," + r.Width + "," + r.Height + (WindowState == FormWindowState.Maximized ? ",max" : ""));
        }
        catch { }
        clipboard.Stop();
        tray.Visible = false;
        tray.Dispose();
        base.OnFormClosing(e);
    }
}

static class Native
{
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    /** The B5 Code window already open, brought to the front. */
    public static void ShowOther()
    {
        var me = Process.GetCurrentProcess();
        foreach (var p in Process.GetProcessesByName(me.ProcessName))
        {
            if (p.Id == me.Id || p.MainWindowHandle == IntPtr.Zero) continue;
            if (IsIconic(p.MainWindowHandle)) ShowWindow(p.MainWindowHandle, 9); // SW_RESTORE
            SetForegroundWindow(p.MainWindowHandle);
            return;
        }
    }

    /** Whether the page's theme is dark: its own choice, or Windows's app colour for "system". */
    public static bool DarkNow(string theme)
    {
        if (theme == "dark") return true;
        if (theme == "light") return false;
        try
        {
            using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"))
            {
                object v = k == null ? null : k.GetValue("AppsUseLightTheme");
                return v is int && (int)v == 0;
            }
        }
        catch { return false; }
    }

    /** The title bar in the page's theme (Windows 10 2004 and later; 19 before that). */
    public static void DarkTitleBar(IntPtr hwnd, bool dark)
    {
        int on = dark ? 1 : 0;
        if (DwmSetWindowAttribute(hwnd, 20, ref on, 4) != 0) DwmSetWindowAttribute(hwnd, 19, ref on, 4);
    }

    // Windows's own folder picker (the Explorer-style one), through COM: .NET Framework's
    // FolderBrowserDialog is the old tree.
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogClass { }

    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, IntPtr specs);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem item);
        void SetFolder(IShellItem item);
        void GetFolder(out IShellItem item);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem
    {
        void BindToHandler(IntPtr bc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
        void GetAttributes(uint mask, out uint attrs);
        void Compare(IShellItem other, uint hint, out int order);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr bc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);

    const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, SIGDN_FILESYSPATH = 0x80058000;

    /** A folder chosen in Windows's picker, or null if cancelled. */
    public static string PickFolder(IntPtr owner, string title, string start)
    {
        var dialog = (IFileOpenDialog)new FileOpenDialogClass();
        try
        {
            dialog.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
            dialog.SetTitle(title);
            dialog.SetOkButtonLabel("Choose");
            try
            {
                IShellItem at;
                SHCreateItemFromParsingName(start, IntPtr.Zero, typeof(IShellItem).GUID, out at);
                dialog.SetFolder(at);
            }
            catch { }
            if (dialog.Show(owner) != 0) return null; // cancelled
            IShellItem item;
            dialog.GetResult(out item);
            string path;
            item.GetDisplayName(SIGDN_FILESYSPATH, out path);
            return path;
        }
        catch { return null; }
        finally { Marshal.ReleaseComObject(dialog); }
    }
}
