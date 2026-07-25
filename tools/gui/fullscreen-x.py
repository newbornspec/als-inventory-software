#!/usr/bin/env python3
"""Force the kiosk browser window to fill the whole screen.

WHY THIS EXISTS: Firefox --kiosk hides the toolbar but opens its window at ~90%
of the screen and never truly fullscreens; no window manager auto-fills it. The
usual fix (xdotool/wmctrl) needs a package that isn't on the live media and
can't always be installed. So this resizer uses ONLY what is guaranteed present
on any X system: python3 + libX11 (via ctypes). No extra packages, no internet.

It runs inside the xinit session (DISPLAY set), reads the real screen size from
X (so it is resolution-independent — any laptop panel or external monitor), and
resizes every large top-level window to the full screen a few times a second for
~40s. That catches the browser once it has finished starting, and stops fighting
it as soon as it is already full-screen.
"""
import ctypes
import ctypes.util
import time


def main():
    libname = ctypes.util.find_library("X11") or "libX11.so.6"
    try:
        X = ctypes.cdll.LoadLibrary(libname)
    except OSError:
        return  # no X libraries here — nothing we can do, exit quietly

    Window = ctypes.c_ulong
    vp = ctypes.c_void_p
    P = ctypes.POINTER
    ci, cu = ctypes.c_int, ctypes.c_uint

    X.XOpenDisplay.restype = vp
    X.XOpenDisplay.argtypes = [ctypes.c_char_p]
    X.XDefaultScreen.restype = ci
    X.XDefaultScreen.argtypes = [vp]
    X.XDisplayWidth.restype = ci
    X.XDisplayWidth.argtypes = [vp, ci]
    X.XDisplayHeight.restype = ci
    X.XDisplayHeight.argtypes = [vp, ci]
    X.XDefaultRootWindow.restype = Window
    X.XDefaultRootWindow.argtypes = [vp]
    X.XQueryTree.argtypes = [vp, Window, P(Window), P(Window), P(P(Window)), P(cu)]
    X.XQueryTree.restype = ci
    X.XGetGeometry.argtypes = [vp, Window, P(Window), P(ci), P(ci), P(cu), P(cu), P(cu), P(cu)]
    X.XGetGeometry.restype = ci
    X.XMoveResizeWindow.argtypes = [vp, Window, ci, ci, cu, cu]
    X.XRaiseWindow.argtypes = [vp, Window]
    X.XSetInputFocus.argtypes = [vp, Window, ci, ctypes.c_ulong]
    X.XFree.argtypes = [vp]
    X.XSync.argtypes = [vp, ci]

    dpy = X.XOpenDisplay(None)
    if not dpy:
        return
    screen = X.XDefaultScreen(dpy)
    sw = X.XDisplayWidth(dpy, screen)
    sh = X.XDisplayHeight(dpy, screen)
    root = X.XDefaultRootWindow(dpy)

    def top_children():
        r, p = Window(), Window()
        ch = P(Window)()
        n = cu()
        if not X.XQueryTree(dpy, root, ctypes.byref(r), ctypes.byref(p),
                            ctypes.byref(ch), ctypes.byref(n)):
            return []
        out = [ch[i] for i in range(n.value)]
        if n.value:
            X.XFree(ch)
        return out

    def size_of(w):
        rr = Window()
        gx, gy = ci(), ci()
        gw, gh, gb, gd = cu(), cu(), cu(), cu()
        if not X.XGetGeometry(dpy, w, ctypes.byref(rr), ctypes.byref(gx), ctypes.byref(gy),
                             ctypes.byref(gw), ctypes.byref(gh), ctypes.byref(gb), ctypes.byref(gd)):
            return (0, 0)
        return (gw.value, gh.value)

    # Watch for ~10 minutes at 1s cadence. It only calls resize when a window is
    # NOT already full, so once the browser fills the screen it costs almost
    # nothing — but it also re-fills instantly if the browser ever shrinks back.
    for _ in range(600):
        for w in top_children():
            gw, gh = size_of(w)
            if gw > 200 and gh > 200 and (gw != sw or gh != sh):
                X.XMoveResizeWindow(dpy, w, 0, 0, sw, sh)
                X.XRaiseWindow(dpy, w)
                X.XSetInputFocus(dpy, w, 2, 0)  # RevertToParent, CurrentTime
        X.XSync(dpy, 0)
        time.sleep(1)


if __name__ == "__main__":
    main()
