// deskmate-hands: the small native helper behind her hands on macOS.
//
// One long-lived process. Each line on stdin is a JSON request {"id": n, "cmd": "...", ...}; each answer is one JSON
// line on stdout {"id": n, "ok": true, ...} or {"id": n, "ok": false, "error": "..."}. Run with a JSON argument
// instead (`deskmate-hands '{"cmd":"permissions"}'`) for a one-shot call from a terminal.
//
// Keys and typing are Quartz events posted to the HID tap, which needs the Accessibility permission of the app that
// started this helper (Deskmate, or Electron / your terminal in development). Apps are launched and activated through
// LaunchServices, which needs nothing. Window titles, the focused element and menus come from the accessibility API.
// Notification banners are read from Notification Center's accessibility tree; calendar events come from EventKit
// (macOS asks for Calendars access once; the usage text is in the Info.plist linked into this binary).

import AppKit
import ApplicationServices
import EventKit
import Foundation
import Vision

let VERSION = "1"

// MARK: - JSON plumbing

typealias Json = [String: Any]

struct HandsError: Error {
  let message: String
  init(_ message: String) { self.message = message }
}

let output = FileHandle.standardOutput
let outputLock = NSLock()

func write(_ obj: Json) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
  outputLock.lock()
  output.write(data)
  output.write("\n".data(using: .utf8)!)
  outputLock.unlock()
}

func str(_ req: Json, _ key: String) -> String? { req[key] as? String }
func int(_ req: Json, _ key: String) -> Int? {
  if let n = req[key] as? NSNumber { return n.intValue }
  return nil
}
func bool(_ req: Json, _ key: String) -> Bool { (req[key] as? NSNumber)?.boolValue ?? false }

func sleepMs(_ ms: Int) { usleep(useconds_t(max(0, ms)) * 1000) }

// MARK: - Apps and windows

/// The app with keyboard focus, read live. NSWorkspace.frontmostApplication is a cached value refreshed by
/// notifications on the main thread, and from this helper's worker thread it stays on whatever was in front at start
/// (measured: it kept saying Claude while TextEdit was active). The accessibility API asks the window server instead;
/// the owner of the front-most normal window is the fallback.
func frontmost() -> NSRunningApplication? {
  var value: AnyObject?
  if AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &value) == .success,
     let el = value {
    var pid: pid_t = 0
    // swiftlint:disable:next force_cast
    if AXUIElementGetPid(el as! AXUIElement, &pid) == .success, let app = NSRunningApplication(processIdentifier: pid) { return app }
  }
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [Json] else { return nil }
  for w in list where (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 {
    if let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, let app = NSRunningApplication(processIdentifier: pid) { return app }
  }
  return nil
}

func runningApp(_ bundleId: String) -> NSRunningApplication? {
  NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first { !$0.isTerminated }
}

/// On-screen, normal-layer windows of a process. CGWindowList gives owner and bounds without any permission.
func windowCount(pid: pid_t) -> Int {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [Json] else { return 0 }
  return list.filter { w in
    (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid && (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
  }.count
}

func axApp(_ pid: pid_t) -> AXUIElement { AXUIElementCreateApplication(pid) }

func axAttr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  guard AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success else { return nil }
  return value
}

func axString(_ el: AXUIElement, _ name: String) -> String? {
  guard let v = axAttr(el, name) else { return nil }
  if let s = v as? String { return s.isEmpty ? nil : s }
  if let a = v as? NSAttributedString { return a.string.isEmpty ? nil : a.string }
  return nil
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] { (axAttr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }

/// Chromium and Electron apps (Discord, Slack, Claude, VS Code) keep their web contents out of the accessibility tree
/// until a client asks for it; this is the switch assistive apps use. Harmless on native apps (they return an error).
func enableElectronAccessibility(_ pid: pid_t) {
  AXUIElementSetAttributeValue(axApp(pid), "AXManualAccessibility" as CFString, kCFBooleanTrue)
}

func focusedWindowTitle(_ pid: pid_t) -> String? {
  let app = axApp(pid)
  if let win = axAttr(app, kAXFocusedWindowAttribute) {
    // swiftlint:disable:next force_cast
    if let t = axString(win as! AXUIElement, kAXTitleAttribute) { return t }
  }
  if let wins = axAttr(app, kAXWindowsAttribute) as? [AXUIElement] {
    for w in wins { if let t = axString(w, kAXTitleAttribute) { return t } }
  }
  return nil
}

func describe(_ el: AXUIElement) -> Json {
  var d: Json = [:]
  for (key, attr) in [
    ("role", kAXRoleAttribute), ("subrole", kAXSubroleAttribute), ("title", kAXTitleAttribute),
    ("description", kAXDescriptionAttribute), ("placeholder", "AXPlaceholderValue"), ("help", kAXHelpAttribute),
  ] {
    if let s = axString(el, attr) { d[key] = s }
  }
  if let v = axString(el, kAXValueAttribute) { d["value"] = String(v.prefix(200)) }
  return d
}

/// `open -b`: launches the app, or reopens and activates it when it runs (an app closed to the tray shows its window
/// again). Since macOS 14 a background process asking to activate another app is usually ignored, whether through
/// NSWorkspace, NSRunningApplication or the accessibility API (all three measured: the app stays behind); Apple's
/// own `open` is allowed to hand focus over.
func openBundle(_ bundleId: String) throws {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
  p.arguments = ["-b", bundleId]
  p.standardOutput = FileHandle.nullDevice
  p.standardError = FileHandle.nullDevice
  try p.run()
  p.waitUntilExit()
  if p.terminationStatus != 0 { throw HandsError("launch_failed: open exited \(p.terminationStatus)") }
}

func launch(bundleId: String, timeoutMs: Int) throws -> Json {
  guard NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) != nil else {
    throw HandsError("not_installed")
  }
  let wasRunning = runningApp(bundleId) != nil
  let started = Date()
  try openBundle(bundleId)
  // Ready when it is in front with a window up. A cold start can sit behind other windows until its main window
  // exists, so ask again every couple of seconds while waiting.
  let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
  var askedAt = Date()
  var asks = 1
  while Date() < deadline {
    if let app = runningApp(bundleId) {
      let pid = app.processIdentifier
      if frontmost()?.bundleIdentifier == bundleId, windowCount(pid: pid) > 0 {
        enableElectronAccessibility(pid)
        return ["pid": Int(pid), "wasRunning": wasRunning, "asks": asks, "ms": Int(Date().timeIntervalSince(started) * 1000)]
      }
    }
    if Date().timeIntervalSince(askedAt) > 2 {
      try? openBundle(bundleId)
      asks += 1
      askedAt = Date()
    }
    sleepMs(100)
  }
  throw HandsError(runningApp(bundleId) == nil ? "launch_timeout" : "no_window")
}

// MARK: - Keyboard

let KEY_CODES: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
  "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
  "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
  "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
  "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
  "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "left": 123, "right": 124, "down": 125, "up": 126,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
  "f11": 103, "f12": 111,
]

let MODIFIERS: [String: (CGEventFlags, CGKeyCode)] = [
  "cmd": (.maskCommand, 55), "command": (.maskCommand, 55),
  "shift": (.maskShift, 56),
  "alt": (.maskAlternate, 58), "option": (.maskAlternate, 58), "opt": (.maskAlternate, 58),
  "ctrl": (.maskControl, 59), "control": (.maskControl, 59),
]

/// Shortcuts that would take control away from the user or close things; never sent on her behalf.
let BLOCKED_COMBOS: Set<String> = ["cmd+q", "cmd+alt+escape", "cmd+option+escape", "cmd+tab", "cmd+space", "ctrl+cmd+q"]

let source = CGEventSource(stateID: .hidSystemState)

func post(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) {
  guard let ev = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { return }
  ev.flags = flags
  ev.post(tap: .cghidEventTap)
}

func pressCombo(_ combo: String) throws {
  let parts = combo.lowercased().split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
  guard let keyName = parts.last else { throw HandsError("empty_combo") }
  if BLOCKED_COMBOS.contains(parts.joined(separator: "+")) { throw HandsError("blocked_combo: \(combo)") }
  var flags: CGEventFlags = []
  var mods: [CGKeyCode] = []
  for m in parts.dropLast() {
    guard let (flag, code) = MODIFIERS[m] else { throw HandsError("unknown_modifier: \(m)") }
    flags.insert(flag)
    mods.append(code)
  }
  guard let code = KEY_CODES[keyName] else { throw HandsError("unknown_key: \(keyName)") }
  // Modifier key events too, not just flags: some Electron builds only see a chord when the modifier went down first.
  var held: CGEventFlags = []
  for (i, m) in mods.enumerated() {
    held.insert(MODIFIERS[String(parts[i])]!.0)
    post(m, down: true, flags: held)
  }
  post(code, down: true, flags: flags)
  sleepMs(12)
  post(code, down: false, flags: flags)
  for (i, m) in mods.enumerated().reversed() {
    held.remove(MODIFIERS[String(parts[i])]!.0)
    post(m, down: false, flags: held)
  }
}

/// Types text as Unicode key events, one character at a time. Paced: Electron text boxes drop characters from a burst.
func typeText(_ text: String, delayMs: Int) {
  // Composed form first: "o" + combining diaeresis in one key event comes out as a bare "o".
  for ch in text.precomposedStringWithCanonicalMapping {
    if ch == "\n" {
      post(36, down: true, flags: [.maskShift])
      post(36, down: false, flags: [.maskShift])
    } else {
      let units = Array(String(ch).utf16)
      for down in [true, false] {
        guard let ev = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
        ev.flags = []
        units.withUnsafeBufferPointer { ev.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress) }
        ev.post(tap: .cghidEventTap)
      }
    }
    sleepMs(delayMs)
  }
}

/// Pastes through the clipboard (fast, any language or emoji, no IME), then puts back what was on it.
func pasteText(_ text: String) throws {
  let pb = NSPasteboard.general
  let saved: [[(NSPasteboard.PasteboardType, Data)]] = (pb.pasteboardItems ?? []).map { item in
    item.types.compactMap { t in item.data(forType: t).map { (t, $0) } }
  }
  pb.clearContents()
  pb.setString(text, forType: .string)
  try pressCombo("cmd+v")
  sleepMs(400)
  pb.clearContents()
  if !saved.isEmpty {
    let items = saved.map { pairs -> NSPasteboardItem in
      let item = NSPasteboardItem()
      for (t, d) in pairs { item.setData(d, forType: t) }
      return item
    }
    pb.writeObjects(items)
  }
}

// MARK: - Text inputs

let EDITABLE_ROLES: Set<String> = ["AXTextArea", "AXTextField", "AXComboBox"]

/// Text inputs in the app's focused window, front to back in tree order. Bounded: Electron trees run to thousands.
func textInputs(_ pid: pid_t, limit: Int = 4000) -> [AXUIElement] {
  guard let win = axAttr(axApp(pid), kAXFocusedWindowAttribute) else { return [] }
  var out: [AXUIElement] = []
  var seen = 0
  func walk(_ el: AXUIElement, _ depth: Int) {
    seen += 1
    if depth > 60 || seen > limit { return }
    if EDITABLE_ROLES.contains(axString(el, kAXRoleAttribute) ?? "") { out.append(el) }
    for child in axChildren(el) { walk(child, depth + 1) }
  }
  // swiftlint:disable:next force_cast
  walk(win as! AXUIElement, 0)
  return out
}

// MARK: - Snapshots for the agent

/// Elements from the last snapshot, by the number the agent saw. Only touched from the worker queue.
var snapshotElements: [AXUIElement] = []
var snapshotPid: pid_t = 0

let ACTIONABLE_ROLES: Set<String> = [
  "AXButton", "AXLink", "AXTextField", "AXTextArea", "AXComboBox", "AXCheckBox", "AXRadioButton", "AXPopUpButton",
  "AXMenuButton", "AXTab", "AXMenuItem", "AXSlider", "AXDisclosureTriangle", "AXIncrementor", "AXSegment", "AXSwitch",
  "AXSearchField", "AXRow", "AXCell", "AXTabButton",
]

func frame(_ el: AXUIElement) -> CGRect? {
  var posV: AnyObject?
  var sizeV: AnyObject?
  guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posV) == .success,
        AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeV) == .success else { return nil }
  var p = CGPoint.zero
  var z = CGSize.zero
  // swiftlint:disable force_cast
  AXValueGetValue(posV as! AXValue, .cgPoint, &p)
  AXValueGetValue(sizeV as! AXValue, .cgSize, &z)
  // swiftlint:enable force_cast
  return CGRect(origin: p, size: z)
}

func label(_ el: AXUIElement) -> String {
  let parts = [kAXTitleAttribute, kAXDescriptionAttribute, "AXPlaceholderValue", kAXHelpAttribute].compactMap { axString(el, $0) }
  var seen = Set<String>()
  return parts.filter { seen.insert($0).inserted }.joined(separator: " · ")
}

/// What the agent sees of the front window: numbered things it can act on, and the text it can read, bounded.
/// Rows and cells only count when they say something; a role with no label and no value is skipped.
func snapshot(_ pid: pid_t, maxElements: Int, maxText: Int) -> Json {
  enableElectronAccessibility(pid)
  let app = axApp(pid)
  guard let winV = axAttr(app, kAXFocusedWindowAttribute) ?? (axAttr(app, kAXWindowsAttribute) as? [AXUIElement])?.first else {
    snapshotElements = []
    return ["title": NSNull(), "elements": [], "text": ""]
  }
  // swiftlint:disable:next force_cast
  let win = winV as! AXUIElement
  var elements: [AXUIElement] = []
  var lines: [String] = []
  var text: [String] = []
  var textLen = 0
  var seenText = Set<String>()
  var visited = 0
  let winFrame = frame(win)
  func walk(_ el: AXUIElement, _ depth: Int) {
    visited += 1
    if depth > 70 || visited > 9000 { return }
    let role = axString(el, kAXRoleAttribute) ?? ""
    let subrole = axString(el, kAXSubroleAttribute) ?? ""
    if role == "AXStaticText" || role == "AXHeading" {
      if let v = axString(el, kAXValueAttribute) ?? axString(el, kAXTitleAttribute) ?? axString(el, kAXDescriptionAttribute) {
        let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty, textLen < maxText, seenText.insert(t).inserted {
          text.append(role == "AXHeading" ? "## \(t)" : t)
          textLen += t.count + 1
        }
      }
    } else if ACTIONABLE_ROLES.contains(role) || subrole == "AXSearchField", elements.count < maxElements {
      let name = label(el)
      let value = axString(el, kAXValueAttribute).map { String($0.prefix(80)) }
      let onScreen = frame(el).map { f in f.width > 1 && f.height > 1 && (winFrame?.intersects(f) ?? true) } ?? false
      let meaningful = !name.isEmpty || value != nil || ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(role)
      if onScreen && meaningful {
        let enabled = (axAttr(el, kAXEnabledAttribute) as? NSNumber)?.boolValue ?? true
        let focused = (axAttr(el, kAXFocusedAttribute) as? NSNumber)?.boolValue ?? false
        let kind = role == "AXTextField" && subrole == "AXSecureTextField" ? "PasswordField" : role.replacingOccurrences(of: "AX", with: "")
        var line = "[\(elements.count)] \(kind)"
        if !name.isEmpty { line += " \"\(name.prefix(100))\"" }
        if let v = value, !v.isEmpty, v != name { line += " = \"\(v)\"" }
        if !enabled { line += " (disabled)" }
        if focused { line += " (focused)" }
        lines.append(line)
        elements.append(el)
      }
    }
    for child in axChildren(el) { walk(child, depth + 1) }
  }
  walk(win, 0)
  snapshotElements = elements
  snapshotPid = pid
  return ["title": axString(win, kAXTitleAttribute) ?? NSNull(), "elements": lines, "text": text.joined(separator: "\n")]
}

func mouseClick(at p: CGPoint) {
  for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
    guard let ev = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: .left) else { continue }
    ev.post(tap: .cghidEventTap)
    sleepMs(type == .mouseMoved ? 40 : 30)
  }
}

/// Finds an installed app by name: running apps first, then the usual Applications folders.
func resolveApp(_ raw: String) -> (String, String)? {
  let want = raw.lowercased().replacingOccurrences(of: ".app", with: "").trimmingCharacters(in: .whitespaces)
  for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
    if let n = app.localizedName?.lowercased(), n == want, let id = app.bundleIdentifier { return (id, app.localizedName ?? raw) }
  }
  let fm = FileManager.default
  let dirs = ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities", NSHomeDirectory() + "/Applications"]
  var loose: (String, String)?
  for dir in dirs {
    guard let names = try? fm.contentsOfDirectory(atPath: dir) else { continue }
    for name in names where name.hasSuffix(".app") {
      let base = String(name.dropLast(4))
      let b = base.lowercased()
      guard b == want || (loose == nil && (b.hasPrefix(want) || b.contains(want))) else { continue }
      guard let id = Bundle(path: "\(dir)/\(name)")?.bundleIdentifier else { continue }
      if b == want { return (id, base) }
      loose = (id, base)
    }
  }
  return loose
}

// MARK: - Reading text off the screen (OCR)

/// Where each item of the last OCR sits on screen, by the number the agent saw.
var ocrRects: [CGRect] = []

/// The app's front-most normal window: its id and bounds in screen points (top-left origin, like AX and CGEvent).
func frontWindow(_ pid: pid_t) -> (CGWindowID, CGRect)? {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [Json] else { return nil }
  for w in list where (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid && (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 {
    guard let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
          let b = w[kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: b as CFDictionary), rect.width > 50, rect.height > 50 else { continue }
    return (id, rect)
  }
  return nil
}

/// Text in an app's front window, read with Vision: for canvas apps, games and web views whose controls the
/// accessibility tree does not describe. Needs Screen Recording for the app that runs the helper.
func ocrWindow(_ pid: pid_t, max: Int) throws -> Json {
  guard let (wid, bounds) = frontWindow(pid) else { throw HandsError("no_window") }
  guard let image = CGWindowListCreateImage(.null, .optionIncludingWindow, wid, [.boundsIgnoreFraming, .bestResolution]) else {
    throw HandsError("capture_failed: allow Screen Recording")
  }
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
  let found = (request.results ?? []).compactMap { obs -> (String, CGRect)? in
    guard let top = obs.topCandidates(1).first, top.confidence > 0.3 else { return nil }
    let bb = obs.boundingBox // normalised, origin bottom-left
    let rect = CGRect(x: bounds.minX + bb.minX * bounds.width, y: bounds.minY + (1 - bb.maxY) * bounds.height,
                      width: bb.width * bounds.width, height: bb.height * bounds.height)
    return (top.string, rect)
  }
  // Reading order: rows top to bottom (within a few points), then left to right.
  let sorted = found.sorted { a, b in abs(a.1.minY - b.1.minY) > 6 ? a.1.minY < b.1.minY : a.1.minX < b.1.minX }.prefix(max)
  ocrRects = sorted.map { $0.1 }
  return ["items": sorted.enumerated().map { "[\($0.offset)] \($0.element.0)" }, "window": ["x": bounds.minX, "y": bounds.minY, "w": bounds.width, "h": bounds.height]]
}

// MARK: - Where things are (for her body)

func rectJson(_ r: CGRect) -> Json { ["x": r.minX, "y": r.minY, "w": r.width, "h": r.height] }

/// The front-most real window on screen that is not one of `exclude` (her own windows), with its id and bounds.
func topWindow(exclude: Set<String>) -> Json? {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [Json] else { return nil }
  for w in list where (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 {
    guard let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
          let app = NSRunningApplication(processIdentifier: pid),
          !exclude.contains(app.bundleIdentifier ?? ""),
          let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
          let b = w[kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: b as CFDictionary), rect.width >= 240, rect.height >= 160 else { continue }
    return ["windowId": Int(id), "bundleId": app.bundleIdentifier ?? "", "app": app.localizedName ?? "", "frame": rectJson(rect)]
  }
  return nil
}

/// A window's current bounds, or nil once it is closed, minimised or on another Space.
func windowBounds(_ id: CGWindowID) -> CGRect? {
  guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [Json], let w = list.first,
        (w[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
        let b = w[kCGWindowBounds as String] as? NSDictionary else { return nil }
  return CGRect(dictionaryRepresentation: b as CFDictionary)
}

/// An element in the app's front window whose name or value matches `text` (exact first, then contains), with its bounds.
func locate(_ pid: pid_t, _ text: String) -> Json? {
  enableElectronAccessibility(pid)
  guard let winV = axAttr(axApp(pid), kAXFocusedWindowAttribute) else { return nil }
  let want = text.lowercased()
  var best: (Int, AXUIElement)? = nil
  var visited = 0
  func walk(_ el: AXUIElement, _ depth: Int) {
    visited += 1
    if depth > 60 || visited > 8000 { return }
    for attr in [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute, kAXFilenameAttribute] {
      guard let v = axString(el, attr)?.lowercased() else { continue }
      let score = v == want ? 3 : v.hasPrefix(want) ? 2 : v.contains(want) ? 1 : 0
      if score > (best?.0 ?? 0), let f = frame(el), f.width > 2, f.height > 2 { best = (score, el) }
    }
    if best?.0 == 3 { return }
    for child in axChildren(el) { walk(child, depth + 1) }
  }
  // swiftlint:disable:next force_cast
  walk(winV as! AXUIElement, 0)
  guard let (_, el) = best, let f = frame(el) else { return nil }
  return ["frame": rectJson(f), "element": describe(el)]
}

// MARK: - Menus

struct MenuEntry {
  let path: [String]
  let element: AXUIElement
  let shortcut: String?
  let enabled: Bool
}

func shortcutLabel(_ el: AXUIElement) -> String? {
  guard let ch = axString(el, "AXMenuItemCmdChar") else { return nil }
  let mods = (axAttr(el, "AXMenuItemCmdModifiers") as? NSNumber)?.intValue ?? 0
  // kAXMenuItemModifier*: shift 1, option 2, control 4, no-command 8
  var s = ""
  if mods & 4 != 0 { s += "ctrl+" }
  if mods & 2 != 0 { s += "alt+" }
  if mods & 1 != 0 { s += "shift+" }
  if mods & 8 == 0 { s += "cmd+" }
  return s + ch.lowercased()
}

func menuEntries(_ pid: pid_t, maxDepth: Int = 3) -> [MenuEntry] {
  guard let bar = axAttr(axApp(pid), kAXMenuBarAttribute) else { return [] }
  var out: [MenuEntry] = []
  func walk(_ el: AXUIElement, _ path: [String], _ depth: Int) {
    for child in axChildren(el) {
      let role = axString(child, kAXRoleAttribute) ?? ""
      if role == "AXMenu" {
        walk(child, path, depth)
        continue
      }
      guard let title = axString(child, kAXTitleAttribute) else { continue }
      let p = path + [title]
      if role == "AXMenuItem" {
        let enabled = (axAttr(child, kAXEnabledAttribute) as? NSNumber)?.boolValue ?? true
        out.append(MenuEntry(path: p, element: child, shortcut: shortcutLabel(child), enabled: enabled))
      }
      if depth < maxDepth { walk(child, p, depth + 1) }
    }
  }
  // swiftlint:disable:next force_cast
  walk(bar as! AXUIElement, [], 0)
  return out
}

func norm(_ s: String) -> String {
  s.lowercased().replacingOccurrences(of: "…", with: "").replacingOccurrences(of: "...", with: "").trimmingCharacters(in: .whitespaces)
}

// MARK: - Notification banners

/// The notifications macOS is showing right now, read from the Notification Center process's accessibility tree: the
/// banners that slide in at the top right, and the list when the user has Notification Center open. No Full Disk
/// Access (the notification database stays closed); only Accessibility, like the rest of her hands. Each one is an
/// AXGroup with an AXNotificationCenter… subrole ("AXNotificationCenterBanner", "…BannerStack", "…Alert"), a
/// description "App, title, subtitle, body[, stacked]", and static texts identified as title / subtitle / body.
func banners() -> Json {
  guard let nc = runningApp("com.apple.notificationcenterui") else { return ["banners": [], "running": false] }
  let app = axApp(nc.processIdentifier)
  var out: [Json] = []
  var panelOpen = false
  for window in (axAttr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] {
    // The open Notification Center panel has the widgets and their "Edit Widgets" button; a banner window does not.
    var panel = false
    var found: [AXUIElement] = []
    func walk(_ el: AXUIElement, _ depth: Int) {
      if depth > 12 { return }
      let role = axString(el, kAXRoleAttribute) ?? ""
      if role == "AXOpaqueProviderGroup" { return } // widgets: big, and never notifications
      if axString(el, kAXIdentifierAttribute) == "widget-editor-button" { panel = true }
      if role == "AXGroup", (axString(el, kAXSubroleAttribute) ?? "").hasPrefix("AXNotificationCenter") {
        found.append(el)
        return
      }
      for c in axChildren(el) { walk(c, depth + 1) }
    }
    walk(window, 0)
    if panel { panelOpen = true }
    for el in found {
      var texts: [String: String] = [:]
      var loose: [String] = []
      for c in axChildren(el) where axString(c, kAXRoleAttribute) == "AXStaticText" {
        guard let v = axString(c, kAXValueAttribute) else { continue }
        if let id = axString(c, kAXIdentifierAttribute), ["title", "subtitle", "body"].contains(id) { texts[id] = v } else { loose.append(v) }
      }
      let desc = axString(el, kAXDescriptionAttribute) ?? ""
      let stacked = desc.hasSuffix(", stacked")
      // The app's name is what the description says before the title.
      var appName = ""
      if let title = texts["title"], let r = desc.range(of: ", \(title)") {
        appName = String(desc[desc.startIndex..<r.lowerBound])
      } else if let comma = desc.range(of: ", ") {
        appName = String(desc[desc.startIndex..<comma.lowerBound])
      }
      if texts["title"] == nil, texts["body"] == nil, loose.isEmpty { continue }
      var b: Json = [
        "id": axString(el, kAXIdentifierAttribute) ?? "",
        "kind": axString(el, kAXSubroleAttribute) ?? "",
        "app": appName,
        "title": texts["title"] ?? "",
        "subtitle": texts["subtitle"] ?? "",
        "body": texts["body"] ?? "",
        "stacked": stacked,
        "inPanel": panel
      ]
      if texts["title"] == nil, texts["body"] == nil { b["body"] = loose.first ?? "" }
      out.append(b)
    }
  }
  return ["banners": out, "running": true, "panelOpen": panelOpen]
}

// MARK: - Calendar (EventKit, read only)

/// notDetermined / restricted / denied / fullAccess / writeOnly (or authorized before macOS 14).
func calendarStatus() -> String {
  switch EKEventStore.authorizationStatus(for: .event) {
  case .notDetermined: return "notDetermined"
  case .restricted: return "restricted"
  case .denied: return "denied"
  case .fullAccess: return "fullAccess" // .authorized before macOS 14 has the same raw value
  case .writeOnly: return "writeOnly"
  @unknown default: return "unknown"
  }
}

/// Asks macOS for read access to the calendars (a one-time prompt; System Settings → Privacy → Calendars after that).
/// Run this as a one-shot call: macOS stops a process that asks without a usage description, and the long-lived
/// helper should never be the one it stops.
func requestCalendarAccess(timeoutMs: Int) -> Json {
  let store = EKEventStore()
  let done = DispatchSemaphore(value: 0)
  var granted = false
  var failure: String?
  let answer = { (ok: Bool, err: Error?) in
    granted = ok
    failure = err?.localizedDescription
    done.signal()
  }
  if #available(macOS 14.0, *) { store.requestFullAccessToEvents(completion: answer) } else { store.requestAccess(to: .event, completion: answer) }
  if done.wait(timeout: .now() + .milliseconds(timeoutMs)) == .timedOut { return ["granted": false, "status": calendarStatus(), "error": "timed out waiting for an answer"] }
  var out: Json = ["granted": granted, "status": calendarStatus()]
  if let f = failure { out["error"] = f }
  return out
}

/// Calendars access belongs to the "responsible" app: the one macOS thinks started us. Packaged, that is Deskmate,
/// which carries the usage text. In development it is whatever launched the dev server (Terminal, an editor, Claude),
/// and a hardened app without the calendar entitlement gets no prompt at all. With "disclaim", the request runs in
/// a child of this helper that disclaims that link, so macOS asks for (and remembers) deskmate-hands itself.
@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

func runDisclaimed(_ req: Json) throws -> Json {
  var inner = req
  inner.removeValue(forKey: "disclaim")
  inner.removeValue(forKey: "id")
  guard let data = try? JSONSerialization.data(withJSONObject: inner), let arg = String(data: data, encoding: .utf8),
        let exe = Bundle.main.executablePath else { throw HandsError("disclaim_failed: no request") }
  var attr: posix_spawnattr_t?
  posix_spawnattr_init(&attr)
  defer { posix_spawnattr_destroy(&attr) }
  _ = responsibility_spawnattrs_setdisclaim(&attr, 1)
  var fds: [Int32] = [0, 0]
  guard pipe(&fds) == 0 else { throw HandsError("disclaim_failed: pipe") }
  var actions: posix_spawn_file_actions_t?
  posix_spawn_file_actions_init(&actions)
  defer { posix_spawn_file_actions_destroy(&actions) }
  posix_spawn_file_actions_adddup2(&actions, fds[1], 1)
  posix_spawn_file_actions_addclose(&actions, fds[0])
  var pid: pid_t = 0
  let argv: [UnsafeMutablePointer<CChar>?] = [strdup(exe), strdup(arg), nil]
  defer { argv.forEach { free($0) } }
  let rc = posix_spawn(&pid, exe, &actions, &attr, argv, environ)
  close(fds[1])
  guard rc == 0 else {
    close(fds[0])
    throw HandsError("disclaim_failed: spawn \(rc)")
  }
  let out = FileHandle(fileDescriptor: fds[0], closeOnDealloc: true).readDataToEndOfFile()
  var status: Int32 = 0
  waitpid(pid, &status, 0)
  guard let line = String(data: out, encoding: .utf8)?.split(separator: "\n").last,
        let obj = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? Json else { throw HandsError("disclaim_failed: no answer (exit \(status))") }
  if (obj["ok"] as? Bool) != true { throw HandsError(obj["error"] as? String ?? "unknown") }
  var result = obj
  result.removeValue(forKey: "ok")
  return result
}

/// Events between now (minus `pastMinutes`) and `minutes` from now, earliest first. Times in ms since 1970.
func calendarEvents(minutes: Int, pastMinutes: Int) throws -> Json {
  let status = calendarStatus()
  guard status == "fullAccess" else { throw HandsError("calendar_access: \(status)") }
  let store = EKEventStore()
  let from = Date().addingTimeInterval(TimeInterval(-60 * pastMinutes))
  let to = Date().addingTimeInterval(TimeInterval(60 * minutes))
  let events = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: nil))
  let ms = { (d: Date) -> Double in (d.timeIntervalSince1970 * 1000).rounded() }
  return ["events": events.sorted { $0.startDate < $1.startDate }.prefix(60).map { e -> Json in
    var j: Json = [
      "id": e.calendarItemIdentifier,
      "title": e.title ?? "",
      "start": ms(e.startDate),
      "end": ms(e.endDate),
      "allDay": e.isAllDay,
      "calendar": e.calendar?.title ?? ""
    ]
    if let loc = e.location, !loc.isEmpty { j["location"] = loc }
    if e.status == .canceled { j["cancelled"] = true }
    return j
  }]
}

// MARK: - Automation (Apple events) permission

/// AEDeterminePermissionToAutomateTarget can block for a long time on some targets (Spotify, while running, with the
/// question never asked) even without asking, so it runs on its own thread and gives up after a while ("timeout"),
/// leaving the helper free for the next request.
func automationStatus(_ bundleId: String, ask: Bool) -> String {
  if NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) == nil { return "notInstalled" }
  var result = "timeout"
  let lock = NSLock()
  let done = DispatchSemaphore(value: 0)
  Thread.detachNewThread {
    let r = determineAutomation(bundleId, ask: ask)
    lock.lock()
    result = r
    lock.unlock()
    done.signal()
  }
  _ = done.wait(timeout: .now() + .seconds(ask ? 120 : 3))
  lock.lock()
  defer { lock.unlock() }
  return result
}

func determineAutomation(_ bundleId: String, ask: Bool) -> String {
  var target = AEAddressDesc()
  let bytes = Array(bundleId.utf8)
  guard AECreateDesc(typeApplicationBundleID, bytes, bytes.count, &target) == noErr else { return "error" }
  defer { AEDisposeDesc(&target) }
  let status = AEDeterminePermissionToAutomateTarget(&target, typeWildCard, typeWildCard, ask)
  switch Int(status) {
  case Int(noErr): return "granted"
  case -1743: return "denied" // errAEEventNotPermitted
  case -1744: return "notDetermined" // errAEEventWouldRequireUserConsent
  case Int(procNotFound): return "notRunning"
  default: return "error \(status)"
  }
}

// MARK: - Commands

func handle(_ req: Json) throws -> Json {
  guard let cmd = str(req, "cmd") else { throw HandsError("no_cmd") }
  // Keys only go to the app the caller expects in front; anything else means the user took over, or focus moved.
  if let expect = str(req, "expect"), frontmost()?.bundleIdentifier != expect {
    throw HandsError("focus_changed: \(frontmost()?.bundleIdentifier ?? "nothing") is in front")
  }
  switch cmd {
  case "ping":
    return ["version": VERSION]
  case "permissions":
    // keys: may post keyboard events (what her hands need). accessibility: AXIsProcessTrusted for this binary, which
    // can read false for a child process even when the app that started it is allowed.
    return ["keys": CGPreflightPostEventAccess(), "accessibility": AXIsProcessTrusted(), "screen": CGPreflightScreenCaptureAccess()]
  case "automation":
    // Whether the app that started this helper may send Apple events to `bundleId` (Messages, Spotify): granted |
    // denied | notDetermined | notRunning | notInstalled | timeout. ask: true shows macOS's question when it has not been asked
    // (the target has to be running), and waits for the answer.
    guard let id = str(req, "bundleId") else { throw HandsError("no_bundleId") }
    return ["status": automationStatus(id, ask: (req["ask"] as? Bool) ?? false)]
  case "promptAccessibility":
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    return ["accessibility": AXIsProcessTrustedWithOptions(opts)]
  case "installed":
    guard let id = str(req, "bundleId") else { throw HandsError("no_bundleId") }
    return ["installed": NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) != nil, "running": runningApp(id) != nil]
  case "launch":
    guard let id = str(req, "bundleId") else { throw HandsError("no_bundleId") }
    return try launch(bundleId: id, timeoutMs: int(req, "timeoutMs") ?? 25_000)
  case "frontmost":
    guard let app = frontmost() else { return [:] }
    var r: Json = ["bundleId": app.bundleIdentifier ?? "", "name": app.localizedName ?? "", "pid": Int(app.processIdentifier)]
    if let t = focusedWindowTitle(app.processIdentifier) { r["title"] = t }
    return r
  case "windowTitle":
    guard let id = str(req, "bundleId"), let app = runningApp(id) else { throw HandsError("not_running") }
    return ["title": focusedWindowTitle(app.processIdentifier) ?? NSNull()]
  case "focused":
    guard let id = str(req, "bundleId"), let app = runningApp(id) else { throw HandsError("not_running") }
    enableElectronAccessibility(app.processIdentifier)
    guard let el = axAttr(axApp(app.processIdentifier), kAXFocusedUIElementAttribute) else { return ["element": NSNull()] }
    // swiftlint:disable:next force_cast
    return ["element": describe(el as! AXUIElement)]
  case "focusInput":
    // Puts the caret in the text box whose label mentions `hint` ("message" finds Discord's "Message #general" and
    // Slack's "Message general"), for when switching chats left focus somewhere else.
    guard let id = str(req, "bundleId"), let app = runningApp(id) else { throw HandsError("not_running") }
    let hint = (str(req, "hint") ?? "").lowercased()
    let inputs = textInputs(app.processIdentifier)
    let label = { (el: AXUIElement) -> String in
      [kAXDescriptionAttribute, "AXPlaceholderValue", kAXTitleAttribute].compactMap { axString(el, $0) }.joined(separator: " ").lowercased()
    }
    guard let target = inputs.first(where: { hint.isEmpty || label($0).contains(hint) }) else {
      throw HandsError("no_input: \(inputs.count) text box(es), none labelled \"\(hint)\"")
    }
    let err = AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    if err != .success { throw HandsError("focus_failed: \(err.rawValue)") }
    return ["element": describe(target)]
  case "resolve":
    guard let name = str(req, "name"), let (id, appName) = resolveApp(name) else { throw HandsError("not_installed") }
    return ["bundleId": id, "name": appName]
  case "snapshot":
    guard let app = str(req, "bundleId").map({ runningApp($0) }) ?? frontmost() else { throw HandsError("not_running") }
    var r = snapshot(app.processIdentifier, maxElements: int(req, "maxElements") ?? 120, maxText: int(req, "maxText") ?? 3500)
    r["app"] = app.localizedName ?? ""
    r["bundleId"] = app.bundleIdentifier ?? ""
    return r
  case "act":
    // press | focus | click on element n of the last snapshot
    guard let n = int(req, "index"), n >= 0, n < snapshotElements.count else { throw HandsError("no_such_element: take a new snapshot") }
    let el = snapshotElements[n]
    var pid: pid_t = 0
    AXUIElementGetPid(el, &pid)
    if pid != snapshotPid { throw HandsError("no_such_element: take a new snapshot") }
    let action = str(req, "action") ?? "press"
    let info = describe(el)
    if action == "focus" {
      let err = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
      if err != .success, let f = frame(el) { mouseClick(at: CGPoint(x: f.midX, y: f.midY)) }
      return ["element": info]
    }
    if action == "press", AXUIElementPerformAction(el, kAXPressAction as CFString) == .success { return ["element": info, "via": "press"] }
    guard let f = frame(el) else { throw HandsError("cannot_click: no position") }
    mouseClick(at: CGPoint(x: f.midX, y: f.midY))
    return ["element": info, "via": "click"]
  case "ocr":
    guard let app = str(req, "bundleId").map({ runningApp($0) }) ?? frontmost() else { throw HandsError("not_running") }
    var r = try ocrWindow(app.processIdentifier, max: int(req, "max") ?? 250)
    r["app"] = app.localizedName ?? ""
    r["bundleId"] = app.bundleIdentifier ?? ""
    return r
  case "clickText":
    guard let n = int(req, "index"), n >= 0, n < ocrRects.count else { throw HandsError("no_such_text: read the screen again") }
    let r = ocrRects[n]
    mouseClick(at: CGPoint(x: r.midX, y: r.midY))
    return [:]
  case "topWindow":
    let exclude = Set((req["exclude"] as? [String]) ?? [])
    return topWindow(exclude: exclude) ?? ["windowId": NSNull()]
  case "windowById":
    guard let id = int(req, "windowId") else { throw HandsError("no_windowId") }
    guard let r = windowBounds(CGWindowID(id)) else { return ["frame": NSNull()] }
    return ["frame": rectJson(r)]
  case "frame":
    guard let n = int(req, "index"), n >= 0, n < snapshotElements.count, let f = frame(snapshotElements[n]) else { throw HandsError("no_such_element: take a new snapshot") }
    return ["frame": rectJson(f)]
  case "textFrame":
    guard let n = int(req, "index"), n >= 0, n < ocrRects.count else { throw HandsError("no_such_text: read the screen again") }
    return ["frame": rectJson(ocrRects[n])]
  case "locate":
    guard let id = str(req, "bundleId"), let app = runningApp(id), let text = str(req, "text") else { throw HandsError("not_running") }
    return locate(app.processIdentifier, text) ?? ["frame": NSNull()]
  case "key":
    guard let combo = str(req, "combo") else { throw HandsError("no_combo") }
    try pressCombo(combo)
    return [:]
  case "type":
    guard let text = str(req, "text") else { throw HandsError("no_text") }
    typeText(text, delayMs: int(req, "delayMs") ?? 10)
    return [:]
  case "paste":
    guard let text = str(req, "text") else { throw HandsError("no_text") }
    try pasteText(text)
    return [:]
  case "menu":
    guard let id = str(req, "bundleId"), let app = runningApp(id) else { throw HandsError("not_running") }
    let entries = menuEntries(app.processIdentifier)
    if let want = req["press"] as? [String], !want.isEmpty {
      // Match the path from the end: ["New Chat"] finds File › New Chat; ["File", "New Chat"] pins it.
      let w = want.map(norm)
      guard let hit = entries.first(where: { e in
        e.enabled && e.path.count >= w.count && zip(e.path.suffix(w.count).map(norm), w).allSatisfy { $0 == $1 }
      }) else { throw HandsError("menu_item_missing: \(want.joined(separator: " > "))") }
      let err = AXUIElementPerformAction(hit.element, kAXPressAction as CFString)
      if err != .success { throw HandsError("menu_press_failed: \(err.rawValue)") }
      return ["pressed": hit.path]
    }
    return ["items": entries.map { e -> Json in
      var d: Json = ["path": e.path, "enabled": e.enabled]
      if let s = e.shortcut { d["shortcut"] = s }
      return d
    }]
  case "banners":
    return banners()
  case _ where ["calendarStatus", "calendarAccess", "calendar"].contains(cmd) && bool(req, "disclaim"):
    return try runDisclaimed(req)
  case "calendarStatus":
    return ["status": calendarStatus()]
  case "calendarAccess":
    return requestCalendarAccess(timeoutMs: int(req, "timeoutMs") ?? 120_000)
  case "calendar":
    return try calendarEvents(minutes: int(req, "minutes") ?? 120, pastMinutes: int(req, "pastMinutes") ?? 0)
  case "sleep":
    sleepMs(int(req, "ms") ?? 100)
    return [:]
  default:
    throw HandsError("unknown_cmd: \(cmd)")
  }
}

func respond(_ req: Json) {
  var out: Json
  do {
    out = try handle(req)
    out["ok"] = true
  } catch let e as HandsError {
    out = ["ok": false, "error": e.message]
  } catch {
    out = ["ok": false, "error": "\(error)"]
  }
  if let id = req["id"] { out["id"] = id }
  write(out)
}

// MARK: - Main

if CommandLine.arguments.count > 1 {
  // One-shot: deskmate-hands '{"cmd":"permissions"}'
  let arg = CommandLine.arguments[1]
  guard let data = arg.data(using: .utf8), let req = (try? JSONSerialization.jsonObject(with: data)) as? Json else {
    FileHandle.standardError.write("usage: deskmate-hands '{\"cmd\":\"ping\"}'\n".data(using: .utf8)!)
    exit(2)
  }
  respond(req)
  exit(0)
}

// Long-lived: requests are handled one at a time, in order, off the main thread (which keeps a run loop for AppKit).
let work = DispatchQueue(label: "deskmate.hands")
Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty else { continue }
    guard let data = line.data(using: .utf8), let req = (try? JSONSerialization.jsonObject(with: data)) as? Json else {
      write(["ok": false, "error": "bad_json"])
      continue
    }
    work.async { respond(req) }
  }
  // stdin closed: Deskmate quit or restarted us.
  work.sync {}
  exit(0)
}
RunLoop.main.run()
