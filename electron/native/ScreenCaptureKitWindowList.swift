import AppKit
import CoreGraphics
import Foundation

struct WindowListEntry: Codable {
	let id: String
	let name: String
	let display_id: String
	let appName: String?
	let windowTitle: String?
	let bundleId: String?
	let x: Double
	let y: Double
	let width: Double
	let height: Double
}

func normalize(_ value: String?) -> String? {
	guard let rawValue = value?.trimmingCharacters(in: .whitespacesAndNewlines), !rawValue.isEmpty else {
		return nil
	}

	return rawValue
}

func doubleValue(_ value: Any?) -> Double? {
	if let number = value as? NSNumber {
		return number.doubleValue
	}
	if let value = value as? Double {
		return value
	}
	if let value = value as? CGFloat {
		return Double(value)
	}
	return nil
}

let excludedBundleIds: Set<String> = [
	"com.apple.controlcenter",
	"com.apple.dock",
	"com.apple.WindowManager",
	"com.apple.wallpaper.agent",
]

let excludedWindowTitles: Set<String> = [
	"Display 1 Backstop",
	"Event Shield Window",
	"Menubar",
	"Offscreen Wallpaper Window",
	"Wallpaper-",
]

func activeDisplays() -> [CGDirectDisplayID] {
	var displayCount: UInt32 = 0
	CGGetActiveDisplayList(0, nil, &displayCount)
	guard displayCount > 0 else {
		return []
	}

	var displays = Array(repeating: CGDirectDisplayID(0), count: Int(displayCount))
	CGGetActiveDisplayList(displayCount, &displays, &displayCount)
	return Array(displays.prefix(Int(displayCount)))
}

let displays = activeDisplays()

func displayId(for frame: CGRect) -> String {
	let midpoint = CGPoint(x: frame.midX, y: frame.midY)
	let matchedDisplay = displays.first { display in
		let displayFrame = CGDisplayBounds(display)
		return displayFrame.intersects(frame) || displayFrame.contains(midpoint)
	}

	return matchedDisplay.map { String($0) } ?? ""
}

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let rawWindows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []

struct RawWindowEntry {
	let entry: WindowListEntry
	let hasRawTitle: Bool
	let bundleId: String?
}

let rawEntries = rawWindows.compactMap { window -> RawWindowEntry? in
	let windowIdValue = window[kCGWindowNumber as String]
	let windowId: UInt32
	if let number = windowIdValue as? NSNumber {
		windowId = number.uint32Value
	} else if let value = windowIdValue as? UInt32 {
		windowId = value
	} else {
		return nil
	}

	let layer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
	guard layer == 0 else {
		return nil
	}

	guard let bounds = window[kCGWindowBounds as String] as? [String: Any],
	      let x = doubleValue(bounds["X"]),
	      let y = doubleValue(bounds["Y"]),
	      let width = doubleValue(bounds["Width"]),
	      let height = doubleValue(bounds["Height"]) else {
		return nil
	}

	guard width >= 50, height >= 50 else {
		return nil
	}

	let appName = normalize(window[kCGWindowOwnerName as String] as? String)
	let windowTitle = normalize(window[kCGWindowName as String] as? String)

	guard appName != nil || windowTitle != nil else {
		return nil
	}

	let pid = (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
	let bundleId = pid > 0
		? normalize(NSRunningApplication(processIdentifier: pid)?.bundleIdentifier)
		: nil

	if let bundleId, excludedBundleIds.contains(bundleId) {
		return nil
	}

	if let windowTitle, excludedWindowTitles.contains(windowTitle) {
		return nil
	}

	let resolvedWindowTitle = windowTitle ?? appName ?? "Window"
	let resolvedName: String
	if let appName, let windowTitle {
		resolvedName = "\(appName) - \(windowTitle)"
	} else {
		resolvedName = resolvedWindowTitle
	}

	let frame = CGRect(x: x, y: y, width: width, height: height)
	let entry = WindowListEntry(
		id: "window:\(windowId):0",
		name: resolvedName,
		display_id: displayId(for: frame),
		appName: appName,
		windowTitle: resolvedWindowTitle,
		bundleId: bundleId,
		x: x,
		y: y,
		width: width,
		height: height
	)

	return RawWindowEntry(entry: entry, hasRawTitle: windowTitle != nil, bundleId: bundleId)
}

// For apps with multiple windows, drop auxiliary windows that lack a distinct
// title (for example sidebar/tab-bar chrome). If all windows from an app lack
// titles, keep them all.
var titledCountByBundle: [String: Int] = [:]
for raw in rawEntries {
	if let bid = raw.bundleId, raw.hasRawTitle {
		titledCountByBundle[bid, default: 0] += 1
	}
}

let entries = rawEntries
	.filter { raw in
		guard let bid = raw.bundleId else { return true }
		if let titled = titledCountByBundle[bid], titled > 0 {
			return raw.hasRawTitle
		}
		return true
	}
	.map { $0.entry }
	.sorted { lhs, rhs in
		let lhsApp = lhs.appName ?? lhs.name
		let rhsApp = rhs.appName ?? rhs.name
		if lhsApp != rhsApp {
			return lhsApp.localizedCaseInsensitiveCompare(rhsApp) == .orderedAscending
		}

		return (lhs.windowTitle ?? lhs.name).localizedCaseInsensitiveCompare(rhs.windowTitle ?? rhs.name) == .orderedAscending
	}

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
let data = try encoder.encode(entries)
FileHandle.standardOutput.write(data)
