#!/usr/bin/env python3
"""Force the kiosk browser's MAIN window to fill the whole screen.

WHY THIS EXISTS: Firefox --kiosk hides the toolbar but opens its window at ~90%
of the screen and never truly fullscreens; no window manager auto-fills it. The
usual fix (xdotool/wmctrl) needs a package that isn't on the live media and
can't always be installed. So this resizer uses ONLY what is guaranteed present
on any X system: python3 + libX11 (via ctypes). No extra packages, no internet.

HARD-LEARNED RULES (from real hardware): a native <select> dropdown is itself a
top-level X window. The first version of this script resized/raised/focused
EVERY large window once a second — so the instant the operator opened the batch
dropdown, its popup was seized and Firefox closed the menu. Symptom: menus
"snap shut" on click; only keyboard selection works. Therefore, exactly like a
real window manager, this script must:

  * skip override-redirect windows — menus, dropdowns and tooltips set this
    flag precisely to say "window managers: hands off";
  * skip windows that are not currently viewable;
  * skip anything smaller than 60% of the screen in either dimension — that is
    a dialog or popup, never the kiosk browser (which opens at ~90%);
  * steal focus/raise at most ONCE per window, when it is first fixed —
    repeatedly focusing every second fights the user;
  * never crash on a window that vanished mid-loop (menus close fast), so a
    no-op X error handler is installed.
"""
import ctypes
import ctypes.util
import time

IS_VIEWABLE = 2          # XWindowAttributes.map_state


class XWA(ctypes.Structure):
    """XWindowAttributes — layout per Xlib.h."""
    _fields_ = [
        ("x", ctypes.c_int), ("y", ctypes.c_int),
        ("width", ctypes.c_int), ("height", ctypes.c_int),
        ("border_width", ctypes.c_int), ("depth", ctypes.c_int),
        ("visual", ctypes.c_void_p), ("root", ctypes.c_ulong),
        ("class_", ctypes.c_int),
        ("bit_gravity", ctypes.c_int), ("win_gravity", ctypes.c_int),
        ("backing_store", ctypes.c_int),
        ("backing_planes", ctypes.c_ulong), ("backing_pixel", ctypes.c_ulong),
        ("save_under", ctypes.c_int),
        ("colormap", ctypes.c_ulong), ("map_installed", ctypes.c_int),
        ("map_state", ctypes.c_int),
        ("all_event_masks", ctypes.c_long), ("your_event_mask", ctypes.c_long),
        ("do_not_propagate_mask", ctypes.c_long),
        ("override_redirect", ctypes.c_int),
        ("screen", ctypes.c_void_p),
    ]


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
    X.XGetWindowAttributes.argtypes = [vp, Window, P(XWA)]
    X.XGetWindowAttributes.restype = ci
    X.XMoveResizeWindow.argtypes = [vp, Window, ci, ci, cu, cu]
    X.XRaiseWindow.argtypes = [vp, Window]
    X.XSetInputFocus.argtypes = [vp, Window, ci, ctypes.c_ulong]
    X.XFree.argtypes = [vp]
    X.XSync.argtypes = [vp, ci]

    # A menu can vanish between "list windows" and "inspect window"; the default
    # Xlib error handler would terminate the process. Ignore errors instead.
    HANDLER = ctypes.CFUNCTYPE(ci, vp, vp)
    noop = HANDLER(lambda d, e: 0)
    X.XSetErrorHandler.argtypes = [HANDLER]
    X.XSetErrorHandler(noop)

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

    focused_once = set()

    # Watch for ~25 minutes: every 1s at first (catch the browser settling),
    # dropping to every 3s once things are stable. Cheap: it only acts on a
    # main-window-sized window that is not already fullscreen.
    for i in range(600):
        for w in top_children():
            a = XWA()
            if not X.XGetWindowAttributes(dpy, w, ctypes.byref(a)):
                continue
            if a.override_redirect or a.map_state != IS_VIEWABLE:
                continue                      # menus/dropdowns/tooltips/hidden
            if a.width < sw * 0.6 or a.height < sh * 0.6:
                continue                      # dialogs and popups, not the kiosk
            if a.width == sw and a.height == sh and a.x == 0 and a.y == 0:
                continue                      # already perfect
            X.XMoveResizeWindow(dpy, w, 0, 0, sw, sh)
            if w not in focused_once:
                # Raise and focus only the first time: doing it every second
                # would fight whatever the operator is interacting with.
                X.XRaiseWindow(dpy, w)
                X.XSetInputFocus(dpy, w, 2, 0)  # RevertToParent, CurrentTime
                focused_once.add(w)
        X.XSync(dpy, 0)
        time.sleep(1 if i < 120 else 3)


if __name__ == "__main__":
    main()
