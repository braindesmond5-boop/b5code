# B5 Code for Windows, installed with one line in PowerShell:
#
#   irm braindesmond5-boop.github.io/b5 | iex
#
# (That short address, a GitHub Pages site, runs this file:
#  irm https://raw.githubusercontent.com/braindesmond5-boop/b5code/main/windows/install.ps1 | iex)
#
# It needs Git, Node.js 20 or newer and Claude Code, and offers to install whichever is missing
# (Git and Node with winget, Claude Code with Anthropic's own installer). Then it downloads B5 Code
# into %LOCALAPPDATA%\Programs\B5 Code, builds its app on this PC, and puts it in the Start menu
# and on the Desktop. B5 Code updates itself from then on; running this again repairs it.

& {
  $ErrorActionPreference = 'Stop'
  $Repo = 'https://github.com/braindesmond5-boop/b5code.git'
  $Dir = Join-Path $env:LOCALAPPDATA 'Programs\B5 Code'

  function Step($text) { Write-Host ''; Write-Host $text -ForegroundColor Cyan }
  function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
  function Yes($question) { $a = Read-Host "$question [Y/n]"; return ($a -eq '' -or $a -match '^[yY]') }
  # A program just installed is on the PATH Windows keeps, not yet on this window's.
  function RefreshPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $local = Join-Path $env:USERPROFILE '.local\bin'
    if ((Test-Path $local) -and ($env:Path -notlike "*$local*")) { $env:Path += ";$local" }
  }
  # Not called Winget: PowerShell ignores case, so that would be `winget` itself and call itself forever.
  function InstallWith-Winget($id, $name) {
    if (-not (Has 'winget')) { throw "$name is needed. Install it, then run this again." }
    winget install --id $id --exact --source winget --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "$name didn't install (winget said $LASTEXITCODE)." }
    RefreshPath
  }

  try {
    Write-Host 'B5 Code for Windows' -ForegroundColor White
    if ([Environment]::OSVersion.Version.Major -lt 10) { throw 'B5 Code needs Windows 10 or 11.' }
    RefreshPath

    Step 'Checking what B5 Code needs...'
    if (-not (Has 'git')) {
      if (Yes 'Git is needed (Claude Code uses it too). Install it now?') { InstallWith-Winget 'Git.Git' 'Git' } else { throw 'Install Git from https://git-scm.com, then run this again.' }
    }
    $nodeOk = $false
    if (Has 'node') { $nodeOk = [int]((node -v) -replace '^v(\d+).*', '$1') -ge 20 }
    if (-not $nodeOk) {
      if (Yes 'Node.js 20 or newer is needed. Install it now?') { InstallWith-Winget 'OpenJS.NodeJS.LTS' 'Node.js' } else { throw 'Install Node.js from https://nodejs.org, then run this again.' }
    }
    if (-not (Has 'claude')) {
      if (Yes 'Claude Code is needed. Install it now (Anthropic''s installer)?') { Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression; RefreshPath }
      else { throw 'Install Claude Code (https://claude.com/claude-code), then run this again.' }
    }
    Write-Host 'Git, Node.js and Claude Code are here.'

    if (Test-Path (Join-Path $Dir '.git')) {
      Step 'Updating B5 Code...'
      node (Join-Path $Dir 'bin\b5.mjs') update
      if ($LASTEXITCODE -ne 0) { throw 'B5 Code could not be updated (see above).' }
    } else {
      Step "Downloading B5 Code into $Dir..."
      New-Item -ItemType Directory -Force -Path (Split-Path $Dir) | Out-Null
      git clone --quiet $Repo $Dir
      if ($LASTEXITCODE -ne 0) { throw 'B5 Code could not be downloaded from GitHub.' }
    }

    Step 'Setting up B5 Code (this takes a minute the first time)...'
    node (Join-Path $Dir 'bin\b5.mjs') setup
    if ($LASTEXITCODE -ne 0) { throw 'B5 Code could not be set up (see above).' }

    # `b5` in any terminal: b5 stop, b5 restart, b5 update.
    $bin = Join-Path $Dir 'bin'
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ";$bin").TrimStart(';'), 'User') }

    $signedIn = $false
    try { $signedIn = (claude auth status 2>$null | ConvertFrom-Json).loggedIn } catch { }
    if (-not $signedIn) {
      Step 'Sign in to Claude'
      Write-Host 'B5 Code uses your Claude subscription through Claude Code.'
      if (Yes 'Sign in now? (Your browser opens)') { claude auth login }
    }

    Step 'B5 Code is installed.'
    Write-Host 'Open it from the Start menu or the Desktop. It updates itself.'
    Start-Process (Join-Path $Dir 'windows\bin\B5Code.exe')
  } catch {
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
  }
}
