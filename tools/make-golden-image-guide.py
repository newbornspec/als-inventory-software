# Builds the golden-image guide PDF for apps/web/public/.
import os

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (BaseDocTemplate, Frame, KeepTogether, ListFlowable,
                                ListItem, PageBreak, PageTemplate, Paragraph, Spacer,
                                Table, TableStyle)

OUT = r"C:\Users\PC\Desktop\Als_Inventory_Software\apps\web\public\golden-image-guide.pdf"

INK = colors.HexColor("#0a0a0a")
MUT = colors.HexColor("#525252")
MUT2 = colors.HexColor("#737373")
BLUE = colors.HexColor("#1d4ed8")
BLSOFT = colors.HexColor("#eff6ff")
LINE = colors.HexColor("#e5e5e5")
CODEBG = colors.HexColor("#f6f7f9")
AMBER = colors.HexColor("#b45309")
AMBERBG = colors.HexColor("#fffbeb")
RED = colors.HexColor("#b91c1c")
REDBG = colors.HexColor("#fef2f2")
GREEN = colors.HexColor("#15803d")
GREENBG = colors.HexColor("#f0fdf4")

ss = getSampleStyleSheet()
S = {}
S["title"] = ParagraphStyle("title", parent=ss["Title"], fontName="Helvetica-Bold",
                            fontSize=25, leading=29, textColor=INK, alignment=TA_LEFT,
                            spaceAfter=4)
S["sub"] = ParagraphStyle("sub", fontName="Helvetica", fontSize=11, leading=15,
                          textColor=MUT, spaceAfter=18)
S["h1"] = ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=15, leading=19,
                         textColor=INK, spaceBefore=20, spaceAfter=7)
S["h2"] = ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=11.5, leading=15,
                         textColor=INK, spaceBefore=13, spaceAfter=5)
S["p"] = ParagraphStyle("p", fontName="Helvetica", fontSize=10, leading=14.5,
                        textColor=INK, spaceAfter=7)
S["small"] = ParagraphStyle("small", fontName="Helvetica", fontSize=9, leading=13,
                            textColor=MUT, spaceAfter=6)
S["code"] = ParagraphStyle("code", fontName="Courier", fontSize=8.6, leading=12.6,
                           textColor=INK, spaceAfter=0, spaceBefore=0)
S["callout"] = ParagraphStyle("callout", fontName="Helvetica", fontSize=9.3, leading=13.2,
                              textColor=INK, spaceAfter=0)
S["li"] = ParagraphStyle("li", parent=S["p"], spaceAfter=4)


def P(t, st="p"):
    return Paragraph(t, S[st])


def code(*lines):
    """A shell block. Kept as one table so it never splits across a page."""
    body = "<br/>".join(l.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                        for l in lines)
    t = Table([[Paragraph(body, S["code"])]], colWidths=[165 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CODEBG),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return [Spacer(1, 3), t, Spacer(1, 9)]


def note(kind, title, text):
    bg, fg = {"warn": (AMBERBG, AMBER), "stop": (REDBG, RED),
              "ok": (GREENBG, GREEN), "info": (BLSOFT, BLUE)}[kind]
    inner = Paragraph('<font color="%s"><b>%s</b></font><br/>%s' % (fg.hexval(), title, text),
                      S["callout"])
    t = Table([[inner]], colWidths=[165 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("LINEBEFORE", (0, 0), (0, -1), 2.4, fg),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return [Spacer(1, 4), t, Spacer(1, 10)]


def bullets(items):
    return ListFlowable([ListItem(P(i, "li"), leftIndent=12) for i in items],
                        bulletType="bullet", start="circle", leftIndent=13,
                        bulletFontSize=6, bulletOffsetY=-1.5)


def steps(items):
    return ListFlowable([ListItem(P(i, "li"), leftIndent=14) for i in items],
                        bulletType="1", leftIndent=16, bulletFontName="Helvetica-Bold")


def kv(rows, widths=(46 * mm, 119 * mm)):
    data = [[Paragraph('<font color="%s">%s</font>' % (MUT.hexval(), k), S["small"]),
             Paragraph(v, S["small"])] for k, v in rows]
    t = Table(data, colWidths=list(widths))
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return [Spacer(1, 2), t, Spacer(1, 10)]


def decorate(canvas, doc):
    canvas.saveState()
    w, h = A4
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(MUT2)
    canvas.drawString(22 * mm, 12 * mm, "ALS Inventory - Creating a Golden Image")
    canvas.drawRightString(w - 22 * mm, 12 * mm, "Page %d" % doc.page)
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.4)
    canvas.line(22 * mm, 15.5 * mm, w - 22 * mm, 15.5 * mm)
    canvas.restoreState()


doc = BaseDocTemplate(OUT, pagesize=A4,
                      leftMargin=22 * mm, rightMargin=23 * mm,
                      topMargin=20 * mm, bottomMargin=20 * mm,
                      title="Creating a Golden Image - ALS Inventory",
                      author="ALS Inventory", subject="Clonezilla golden image workflow")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")
doc.addPageTemplates([PageTemplate(id="all", frames=[frame], onPage=decorate)])

F = []
A = F.append
E = F.extend

# ----------------------------------------------------------------- cover ----
A(P("Creating a Golden Image", "title"))
A(P("Building, capturing, verifying and publishing a Windows image "
    "for the ALS audit stations.", "sub"))

E(kv([
    ("Image server", "<b>192.168.0.20</b> &nbsp; (user <font face='Courier'>stephen01</font>)"),
    ("Staging folder", "<font face='Courier'>/srv/als-incoming</font> &nbsp; writable - captures land here"),
    ("Image library", "<font face='Courier'>/srv/als-images</font> &nbsp; read-only to stations"),
    ("Seen by stations as", "<font face='Courier'>/home/partimag</font> on the audit station"),
]))

A(P("The whole job in one line", "h2"))
A(P("Build a machine &rarr; sysprep it &rarr; capture it with Clonezilla to the staging "
    "folder &rarr; verify the capture &rarr; move it into the library &rarr; name it on a "
    "station. Roughly 2 to 3 hours, most of which is unattended.", "p"))

E(note("info", "Why the library is read-only",
       "Stations mount it read-only on purpose. A machine being wiped or imaged can never "
       "corrupt or encrypt your golden images, even if that machine is compromised. This is "
       "why captures land in a separate writable folder and are moved in afterwards."))

# ------------------------------------------------------------- checklist ----
A(P("Before you start", "h1"))
A(bullets([
    "A machine to build the image on. Its disk should be <b>no larger than</b> the smallest "
    "machine you will restore onto. An image captured from a 256&nbsp;GB disk will not restore "
    "onto a 128&nbsp;GB one.",
    "A wired network cable to the image server. Over Wi-Fi a 15&nbsp;GB capture takes 20-30 "
    "minutes instead of about 2 and a half.",
    "A Clonezilla boot USB (not the audit stick - a plain Clonezilla Live stick).",
    "Free space on the server: at least 1.5&times; the size of the image you are about to make.",
    "Your Windows licence / activation approach settled before you capture, not after.",
]))

E(code("ssh stephen01@192.168.0.20",
       "df -h /srv"))

A(P("Look at the <b>Avail</b> column for the filesystem holding <font face='Courier'>/srv</font>. "
   "A Windows 11 image typically compresses to 12-18&nbsp;GB.", "small"))

# ---------------------------------------------------------------- step 1 ----
A(PageBreak())
A(P("Step 1 &nbsp;&middot;&nbsp; Build the reference machine", "h1"))
A(P("Install and configure one machine exactly as you want every customer to receive it. "
    "Everything you do here is copied to every future machine, and anything you forget has "
    "to be done by hand on all of them.", "p"))

A(P("Do install", "h2"))
A(bullets([
    "Windows, fully updated.",
    "Chipset, graphics, network and audio drivers.",
    "Your standard software set.",
    "Any default settings, power plan, or branding you want shipped.",
]))

A(P("Do not install", "h2"))
A(bullets([
    "Anything tied to one machine's hardware - a driver for a graphics card only that model has.",
    "Anything licensed per-machine that cannot be re-activated.",
    "Personal accounts. Sign out of everything.",
]))

E(note("warn", "Leave the disk smaller than you think you need",
       "Clonezilla restores a disk image onto a disk of the same size or larger, never smaller. "
       "Build on the smallest capacity you stock. The station refuses a target that is too small, "
       "but only after you have started."))

# ---------------------------------------------------------------- step 2 ----
A(P("Step 2 &nbsp;&middot;&nbsp; Sysprep &mdash; do not skip this", "h1"))
A(P("Sysprep strips the machine-specific identity: the security ID, the computer name, the "
    "hardware-tied activation state. Without it every machine you ship carries the same identity, "
    "which breaks Windows Update on some units, breaks domain joins, and is not something you "
    "want to discover after shipping fifty machines.", "p"))

A(P("On the reference machine, in an Administrator Command Prompt:", "p"))
E(code(r"C:\Windows\System32\Sysprep\sysprep.exe /generalize /oobe /shutdown"))

A(P("The machine shuts itself down when it finishes. <b>Do not switch it back on</b> - booting "
   "Windows again undoes the generalize step and you would have to run it a second time. Go "
   "straight to the capture.", "p"))

E(note("stop", "If sysprep refuses to run",
       "Usually a Microsoft Store app blocking generalize. The log at "
       "<font face='Courier'>C:\\Windows\\System32\\Sysprep\\Panther\\setuperr.log</font> names "
       "the package. Remove it for all users, then run sysprep again. Do not work around it by "
       "skipping /generalize."))

# ---------------------------------------------------------------- step 3 ----
A(PageBreak())
A(P("Step 3 &nbsp;&middot;&nbsp; Capture the image to the server", "h1"))
A(P("Boot the reference machine from the <b>Clonezilla</b> USB, with the network cable plugged in.", "p"))

A(steps([
    "Language and keyboard - accept the defaults.",
    "<b>Start_Clonezilla</b>",
    "<b>device-image</b>",
    "<b>nfs_server</b>",
    "Network - <b>dhcp</b>",
    "NFS version - <b>nfs</b> (v3)",
    "Server IP - <font face='Courier'><b>192.168.0.20</b></font>",
    "Directory - <font face='Courier'><b>/srv/als-incoming</b></font>",
    "<b>Beginner</b> mode",
    "<b>savedisk</b>",
    "Image name - type a name with no spaces, e.g. <font face='Courier'>win11-office</font>",
    "Source disk - pick the internal disk (<font face='Courier'>sda</font> or <font face='Courier'>nvme0n1</font>)",
    "Accept the defaults for the remaining prompts, and confirm.",
]))

E(note("info", "Capture to the staging folder, never straight to the library",
       "<font face='Courier'>/srv/als-incoming</font> is writable; "
       "<font face='Courier'>/srv/als-images</font> is not. Capturing into staging is what stops "
       "a failed capture from replacing a good image that was working yesterday."))

A(P("A 15&nbsp;GB image takes roughly 15-25 minutes over gigabit. Leave it alone until it says "
   "it has finished.", "p"))

# ---------------------------------------------------------------- step 4 ----
A(PageBreak())
A(P("Step 4 &nbsp;&middot;&nbsp; Verify the capture before you trust it", "h1"))
A(P("This step exists because captures fail quietly. A full disk or an overheating server can "
    "end a capture part-way and still leave a folder that looks perfectly normal. Five minutes "
    "here saves finding out on a customer's machine.", "p"))

A(P("Log in to the server and set the name you used:", "p"))
E(code("ssh stephen01@192.168.0.20",
       "IMG=win11-office",
       "cd /srv/als-incoming/$IMG"))

A(P("a. Did it finish?", "h2"))
E(code("ls -l clonezilla-img disk parts *-pt.sf",
       "tail -5 clonezilla-img"))
A(P("All four must exist. <font face='Courier'>clonezilla-img</font> is written last on a "
   "successful save, so its presence is the single best sign the capture ran to completion.", "small"))

A(P("b. Any errors hidden in the log?", "h2"))
E(code("grep -inE 'no space|write error|not saved correctly|failed' clonezilla-img; echo \"exit=$?\""))
A(P("You want no lines printed and <font face='Courier'>exit=1</font>. Anything printed means "
   "recapture.", "small"))

A(P("c. Is every partition actually there?", "h2"))
E(code("for p in $(cat parts); do ls -1 ${p}.*-img* 2>/dev/null || echo \"MISSING: $p\"; done"))

A(P("d. Is the data intact?", "h2"))
A(P("The definitive test. It decompresses every payload and checks the internal checksums, "
   "writing nothing. Several minutes on a 15&nbsp;GB image.", "p"))
E(code("zstd -t -T2 --no-progress *.zst; echo \"exit=$?\""))

E(note("warn", "Keep the -T2",
       "It limits the test to two CPU cores. Letting it use every core has previously pushed this "
       "server to 94&nbsp;&deg;C and triggered a thermal shutdown - which then looks exactly like "
       "a corrupt image. <font face='Courier'>exit=0</font> means intact. "
       "<font face='Courier'>premature end</font> means truncated; "
       "<font face='Courier'>Decoding error</font> means corrupt. Either way, recapture."))

# ---------------------------------------------------------------- step 5 ----
A(P("Step 5 &nbsp;&middot;&nbsp; Publish it to the library", "h1"))
A(P("Only once every check above has passed:", "p"))
E(code("sudo mv /srv/als-incoming/$IMG /srv/als-images/$IMG",
       "sudo chown -R nobody:nogroup /srv/als-images/$IMG",
       "ls -l /srv/als-images/"))

A(P("That is all that is required. The stations pick it up on their own - there is no manifest "
   "to edit. An image folder that is present and complete is offered under its folder name; one "
   "that is incomplete is not offered at all.", "p"))

# ---------------------------------------------------------------- step 6 ----
A(P("Step 6 &nbsp;&middot;&nbsp; Give it a proper name", "h1"))
A(P("On any audit station, in <b>Load OS image</b>:", "p"))
A(steps([
    "Pick the new image in <b>Select OS image</b>. It appears under its folder name, marked "
    "<i>not named yet</i>.",
    "Click <b>Rename</b>.",
    "Type the name that says what the image is - <i>Windows 11 Pro - Standard Office</i>.",
    "Click <b>Save</b>.",
]))
A(P("That name is what the picker shows from then on. Name images by what they are <b>for</b>, "
   "not by their Windows version - three images all reading <i>Windows 11 Pro 23H2</i> tell you "
   "nothing about which is which.", "p"))

E(note("info", "Names are stored per stick",
       "The name lives on the USB stick, because the image library is read-only. If you build a "
       "second audit stick, name the images on that one too. Clearing the field restores the "
       "original folder name."))

# ---------------------------------------------------------------- step 7 ----
A(P("Step 7 &nbsp;&middot;&nbsp; Test it on one machine", "h1"))
A(P("Never put a brand new image into production without restoring it once.", "p"))
A(steps([
    "Take a scrap machine of the type you will be imaging.",
    "Boot the audit stick, select the drive and the new image, and click <b>Load OS Image</b>.",
    "Wait. The panel shows GB written as it goes; a large NTFS partition can be quiet for a "
    "while at the start.",
    "When it shows <b>Completed</b>, reboot the machine <i>without</i> the stick.",
    "Confirm Windows reaches the out-of-box setup screen, the network works, and the display "
    "driver is correct.",
]))

E(note("ok", "What a good restore looks like",
       "The status panel ends on <b>Completed</b> with the image name and target drive. "
       "If it ends on <b>Failed</b>, open <b>Show details</b> - the last output from "
       "Clonezilla, the decompressor and partclone is all captured there."))

# ------------------------------------------------------------ troubleshoot --
A(PageBreak())
A(P("When something goes wrong", "h1"))

A(P("The restore sits at 0% and says nothing", "h2"))
A(P("Usually normal. Clonezilla can be silent for the whole of a large partition. The status "
   "line reports GB written straight from the kernel, so if that number is climbing it is "
   "working, whatever the percentage says. If you need certainty, press "
   "<b>Ctrl-Alt-F2</b> on the station and run:", "p"))
E(code("while :; do awk '{printf \"%s  written: %.1f GB\\n\", strftime(\"%H:%M:%S\"), $7/2097152}' \\",
       "  /sys/block/nvme0n1/stat; sleep 5; done"))
A(P("Climbing means healthy. Flat for a minute or more means genuinely stuck. "
   "<b>Ctrl-C</b> to stop, <b>Ctrl-Alt-F1</b> to return.", "small"))

A(P("\"No space left on device\" during capture", "h2"))
A(P("The server ran out of room. Delete old captures from "
   "<font face='Courier'>/srv/als-incoming</font> and start again. Check first with "
   "<font face='Courier'>df -h /srv</font>.", "p"))

A(P("The capture stopped part-way for no obvious reason", "h2"))
A(P("Check whether the server overheated - this has happened before:", "p"))
E(code("journalctl -k --no-pager | grep -iE 'critical temperature|thermal|mce' | tail -5",
       "sensors"))

A(P("The image does not appear on the station", "h2"))
A(bullets([
    "It is still in <font face='Courier'>/srv/als-incoming</font> - move it to "
    "<font face='Courier'>/srv/als-images</font>.",
    "It is incomplete. An image without <font face='Courier'>disk</font>, "
    "<font face='Courier'>parts</font> and <font face='Courier'>clonezilla-img</font> is "
    "deliberately not offered.",
    "The station cannot reach the server. Check <b>Settings &rarr; Image server</b> reads "
    "<font face='Courier'>192.168.0.20:/srv/als-images</font>.",
]))

A(P("Restored Windows will not boot", "h2"))
A(P("Almost always a partition-only restore rather than a whole-disk one. The station only ever "
   "restores whole disks, so if you see this, the image itself was captured from a partition "
   "rather than a disk. Recapture using <b>savedisk</b>, not <b>saveparts</b>.", "p"))

# ------------------------------------------------------------ quick sheet ---
A(P("Quick reference", "h1"))
A(P("Everything above, condensed. <font face='Courier'>IMG</font> is your image folder name.", "small"))
E(code("# on the server",
       "ssh stephen01@192.168.0.20",
       "IMG=win11-office",
       "",
       "# 1. verify a fresh capture",
       "cd /srv/als-incoming/$IMG",
       "ls -l clonezilla-img disk parts *-pt.sf",
       "grep -inE 'no space|write error|not saved correctly|failed' clonezilla-img",
       "zstd -t -T2 --no-progress *.zst; echo \"exit=$?\"",
       "",
       "# 2. publish it",
       "sudo mv /srv/als-incoming/$IMG /srv/als-images/$IMG",
       "sudo chown -R nobody:nogroup /srv/als-images/$IMG",
       "",
       "# 3. check free space before the next one",
       "df -h /srv"))

A(P("On the reference machine, before capturing:", "small"))
E(code(r"C:\Windows\System32\Sysprep\sysprep.exe /generalize /oobe /shutdown"))

A(Spacer(1, 6))
A(P("Clonezilla menu path: <b>Start_Clonezilla &rarr; device-image &rarr; nfs_server &rarr; dhcp "
   "&rarr; nfs &rarr; 192.168.0.20 &rarr; /srv/als-incoming &rarr; Beginner &rarr; savedisk</b>", "small"))

doc.build(F)
print("written: %s  (%.0f KB)" % (OUT, os.path.getsize(OUT) / 1024.0))
