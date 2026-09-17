#!/usr/bin/env python3
"""Build the operator guide PDF for creating a Windows golden image.

Written as a script rather than a one-off so the guide can be regenerated when
the procedure changes - a printed copy on a warehouse wall goes stale silently,
and the fix for that is making it cheap to reprint.

    python tools/make-image-guide-pdf.py
"""
import os

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (BaseDocTemplate, Frame, KeepTogether, PageTemplate,
                                Paragraph, Spacer, Table, TableStyle)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "Creating-a-Windows-Image.pdf")

NAVY = colors.HexColor("#0b1220")
BLUE = colors.HexColor("#1f3350")
ACCENT = colors.HexColor("#2563eb")
WARN_BG = colors.HexColor("#fff4ed")
WARN_BD = colors.HexColor("#c2410c")
CODE_BG = colors.HexColor("#f4f6fa")
MUTED = colors.HexColor("#5b6b82")
RULE = colors.HexColor("#d7dee8")

ss = getSampleStyleSheet()


def style(name, **kw):
    kw.setdefault("fontName", "Helvetica")
    kw.setdefault("fontSize", 10)
    kw.setdefault("leading", 14.5)
    kw.setdefault("textColor", NAVY)
    kw.setdefault("alignment", TA_LEFT)
    return ParagraphStyle(name, parent=ss["Normal"], **kw)


BODY = style("body", spaceAfter=7)
LEAD = style("lead", fontSize=11, leading=16, textColor=BLUE, spaceAfter=10)
H1 = style("h1", fontName="Helvetica-Bold", fontSize=19, leading=23,
           spaceAfter=3)
H2 = style("h2", fontName="Helvetica-Bold", fontSize=12.5, leading=16,
           textColor=BLUE, spaceBefore=13, spaceAfter=5)
STEPNO = style("stepno", fontName="Helvetica-Bold", fontSize=15, leading=17,
               textColor=ACCENT)
STEPH = style("steph", fontName="Helvetica-Bold", fontSize=12.5, leading=16)
CODE = style("code", fontName="Courier-Bold", fontSize=9, leading=13,
             textColor=BLUE)
SMALL = style("small", fontSize=8.7, leading=12, textColor=MUTED)
WARN = style("warn", fontSize=9.6, leading=13.5)


def code(text):
    """A command in a tinted box. Courier so an operator can transcribe it."""
    t = Table([[Paragraph(text, CODE)]], colWidths=[165 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CODE_BG),
        ("BOX", (0, 0), (-1, -1), 0.6, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return t


def callout(title, body, bg=WARN_BG, bd=WARN_BD):
    inner = [Paragraph("<b>%s</b>" % title, style("ct", fontSize=10,
                                                  leading=13.5, textColor=bd)),
             Spacer(1, 3),
             Paragraph(body, WARN)]
    t = Table([[inner]], colWidths=[165 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("LINEBEFORE", (0, 0), (0, -1), 2.5, bd),
        ("LEFTPADDING", (0, 0), (-1, -1), 11),
        ("RIGHTPADDING", (0, 0), (-1, -1), 11),
        ("TOPPADDING", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ]))
    return t


def step(n, heading, flow):
    """A numbered step, kept on one page so an instruction never splits."""
    head = Table([[Paragraph(str(n), STEPNO), Paragraph(heading, STEPH)]],
                 colWidths=[11 * mm, 154 * mm])
    head.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return KeepTogether([Spacer(1, 9), head] + flow)


def furniture(canvas, doc):
    canvas.saveState()
    w, h = A4
    canvas.setFillColor(NAVY)
    canvas.rect(0, h - 15 * mm, w, 15 * mm, stroke=0, fill=1)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(22 * mm, h - 10 * mm, "ALS AUDIT STATION")
    canvas.setFont("Helvetica", 9)
    canvas.drawRightString(w - 22 * mm, h - 10 * mm, "Creating a Windows Image")
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.6)
    canvas.line(22 * mm, 15 * mm, w - 22 * mm, 15 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 8)
    canvas.drawString(22 * mm, 10 * mm,
                      "Regenerate: python tools/make-image-guide-pdf.py")
    canvas.drawRightString(w - 22 * mm, 10 * mm, "Page %d" % doc.page)
    canvas.restoreState()


def build():
    doc = BaseDocTemplate(OUT, pagesize=A4,
                          leftMargin=22 * mm, rightMargin=22 * mm,
                          topMargin=23 * mm, bottomMargin=20 * mm,
                          title="Creating a Windows Image for the ALS Image Server",
                          author="ALS Audit Station")
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height,
                  id="body")
    doc.addPageTemplates([PageTemplate(id="std", frames=[frame],
                                       onPage=furniture)])

    s = []
    s.append(Paragraph("Creating a Windows Image", H1))
    s.append(Paragraph("A golden image for the ALS image server", LEAD))
    s.append(Paragraph(
        "One reference machine, captured once, restored onto every unit that "
        "comes through. This is the procedure end to end - build, generalise, "
        "capture, publish, verify.", BODY))

    s.append(Spacer(1, 6))
    s.append(callout(
        "Before you start: the stick cannot restore these images yet",
        "The restore path needs Clonezilla's <font face='Courier'>ocs-sr</font>, "
        "and the overlay layer currently bakes in "
        "<font face='Courier'>partclone</font> but not "
        "<font face='Courier'>clonezilla</font>. You can create images now, but "
        "restoring will stop with <i>\u201cClonezilla (ocs-sr) is not installed on "
        "this boot media\u201d</i> unless that bench has internet. Ask for "
        "clonezilla to be added to the layer before relying on this in "
        "production."))

    # ---------------------------------------------------------------- step 1
    s.append(step(1, "Build the reference machine", [
        Paragraph(
            "Install Windows on a representative machine, then add drivers, "
            "every available Windows Update, and your standard software. "
            "Whatever is on this machine is what every customer receives.", BODY),
        Paragraph("Two things to get right before you go near Sysprep, because "
                  "they cause the most common failure:", BODY),
        Paragraph(
            "<b>Use a local account.</b> Do not sign in with a Microsoft "
            "account. Per-user Store apps are the number one cause of "
            "<i>\u201cSysprep was not able to validate your Windows "
            "installation\u201d</i>.", BODY),
        Paragraph(
            "<b>Pause Windows Update.</b> Left running, it re-provisions Store "
            "apps behind you and reintroduces the same failure after you have "
            "cleaned them out.", BODY),
    ]))

    # ---------------------------------------------------------------- step 2
    s.append(step(2, "Sysprep \u2014 do not skip this", [
        code("C:\\Windows\\System32\\Sysprep\\sysprep.exe /generalize /oobe /shutdown"),
        Spacer(1, 6),
        Paragraph(
            "<b>/generalize</b> strips the machine SID, hardware-specific "
            "drivers and the activation state. Without it every customer "
            "receives a clone carrying the same machine identity, which breaks "
            "domain joins and is visible to anyone who looks.", BODY),
        Paragraph(
            "It shuts the machine down by itself. <b>Do not let it boot back "
            "into Windows</b> \u2014 if it does, you have to Sysprep again.", BODY),
        Paragraph("If it errors, the log names the offending app:", BODY),
        code("C:\\Windows\\System32\\Sysprep\\Panther\\setupact.log"),
        Spacer(1, 6),
        Paragraph(
            "<b>Keep a pre-Sysprep snapshot.</b> /generalize can only run a "
            "limited number of times on one installation \u2014 three on retail "
            "licensing. Without a snapshot you cannot update the image later "
            "without rebuilding it from scratch.", BODY),
    ]))

    # ---------------------------------------------------------------- step 3
    s.append(step(3, "Capture it to the server", [
        Paragraph(
            "Boot the reference machine from a <b>Clonezilla</b> USB \u2014 not "
            "the audit stick.", BODY),
        Paragraph(
            "1. Choose <b>device-image</b><br/>"
            "2. Mount the server: <b>nfs_server</b> for a Linux server, "
            "<b>samba_server</b> for a Windows share<br/>"
            "3. Point it at <font face='Courier'>/srv/als-images</font> "
            "(or <font face='Courier'>//server/als-images</font>)<br/>"
            "4. Choose <b>savedisk</b><br/>"
            "5. Name it to match the manifest entry, e.g. "
            "<font face='Courier'>win11pro</font><br/>"
            "6. Accept the defaults for compression and splitting", BODY),
        Spacer(1, 3),
        Paragraph(
            "<b>Use a cable.</b> 15 GB over gigabit ethernet takes about two "
            "and a half minutes. The same image over Wi-Fi on older hardware "
            "takes twenty to thirty.", BODY),
    ]))

    # ---------------------------------------------------------------- step 4
    s.append(step(4, "Publish it", [
        Paragraph(
            "Add an entry to <font face='Courier'>manifest.json</font> on the "
            "server. The <font face='Courier'>dir</font> value must match the "
            "folder name exactly:", BODY),
        code('{ "id": "win11pro", "name": "Windows 11 Pro",<br/>'
             '&nbsp;&nbsp;"version": "24H2 64-bit", "type": "clonezilla",<br/>'
             '&nbsp;&nbsp;"dir": "win11pro", "icon": "windows" }'),
        Spacer(1, 6),
        Paragraph(
            "No code change is needed \u2014 the kiosk reads this file at "
            "startup. An entry whose folder is missing appears as "
            "<b>(image missing)</b> and cannot be selected, so a half-copied "
            "image can never be restored by accident.", BODY),
    ]))

    # ---------------------------------------------------------------- step 5
    s.append(step(5, "Verify before you trust it", [
        Paragraph(
            "The restore checks for a <font face='Courier'>clonezilla-img</font> "
            "file inside the folder, so confirm it exists:", BODY),
        code("ls /srv/als-images/win11pro/clonezilla-img"),
        Spacer(1, 6),
        Paragraph(
            "Then restore it onto a scrap machine and boot it once, through to "
            "the Windows out-of-box setup. <b>An image nobody has restored is "
            "a guess</b>, and the moment to discover a bad capture is now, not "
            "when a customer's machine is half-written.", BODY),
    ]))

    # ---------------------------------------------------------------- notes
    s.append(Spacer(1, 12))
    s.append(Paragraph("Worth knowing", H2))

    rows = [
        ["Single point of failure",
         "If the image server is down, imaging stops on every bench. Keep one "
         "stick carrying a copy of the current Windows image as a fallback."],
        ["The share is read-only",
         "Stations mount it read-only, so a compromised machine being imaged "
         "can never corrupt or encrypt your golden images."],
        ["Server off or cable out",
         "The mount is soft, so a station does not hang. It warns and falls "
         "back to whatever images are on the stick."],
        ["Serve time as well",
         "Second-hand machines usually have a dead CMOS battery and boot with "
         "the wrong date, which breaks HTTPS and makes audits fail to upload. "
         "Run chrony on the same server."],
    ]
    data = [[Paragraph("<b>%s</b>" % a, style("k", fontSize=9.4, leading=13)),
             Paragraph(b, style("v", fontSize=9.4, leading=13))] for a, b in rows]
    t = Table(data, colWidths=[42 * mm, 123 * mm])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -2), 0.5, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    s.append(t)

    s.append(Spacer(1, 10))
    s.append(Paragraph(
        "Full server setup \u2014 installing the share, the folder layout and "
        "pointing stations at it \u2014 is in "
        "<font face='Courier'>tools/IMAGE-SERVER-SETUP.md</font>.", SMALL))

    doc.build(s)
    print("wrote %s (%d bytes)" % (OUT, os.path.getsize(OUT)))


if __name__ == "__main__":
    build()
