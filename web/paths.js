// Path rules the page and the server share. Paths come as the computer writes them:
// /Users/me/x on a Mac, C:\Users\me\x on Windows.

/** The last part of a path, either slash. */
export const baseName = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || String(p || "");
