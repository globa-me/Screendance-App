import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

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

// MARK: - Thumbnail mode
//
// `recordly-window-list --thumbnails <maxWidth> <maxHeight> [--exclude-pid <pid>] [id ...]`
// prints a JSON object mapping source ids ("window:<id>:0" or "display:<id>") to
// JPEG data URLs. Without explicit ids it captures every shareable display and
// on-screen window. Failures for individual sources are omitted.

func argumentValue(after flag: String) -> String? {
	let arguments = CommandLine.arguments
	guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else {
		return nil
	}
	return arguments[index + 1]
}

func fittedSize(width: Double, height: Double, maxWidth: Double, maxHeight: Double) -> (Int, Int) {
	guard width > 0, height > 0 else {
		return (Int(maxWidth), Int(maxHeight))
	}
	let scale = min(maxWidth / width, maxHeight / height, 1)
	return (max(2, Int((width * scale).rounded())), max(2, Int((height * scale).rounded())))
}

func jpegDataURL(from image: CGImage) -> String? {
	let bitmap = NSBitmapImageRep(cgImage: image)
	guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.72]) else {
		return nil
	}
	return "data:image/jpeg;base64,\(data.base64EncodedString())"
}

@available(macOS 14.0, *)
func captureThumbnail(filter: SCContentFilter, frame: CGRect, maxWidth: Double, maxHeight: Double) async -> String? {
	let configuration = SCStreamConfiguration()
	let (width, height) = fittedSize(
		width: Double(frame.width),
		height: Double(frame.height),
		maxWidth: maxWidth,
		maxHeight: maxHeight
	)
	configuration.width = width
	configuration.height = height
	configuration.showsCursor = false
	configuration.scalesToFit = true
	configuration.ignoreShadowsSingleWindow = true
	do {
		let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
		return jpegDataURL(from: image)
	} catch {
		return nil
	}
}

@available(macOS 14.0, *)
func captureThumbnails() async -> [String: String] {
	let arguments = CommandLine.arguments
	let thumbnailsIndex = arguments.firstIndex(of: "--thumbnails") ?? 0
	let maxWidth = Double(argumentValue(after: "--thumbnails") ?? "") ?? 320
	let maxHeight = thumbnailsIndex + 2 < arguments.count ? Double(arguments[thumbnailsIndex + 2]) ?? 180 : 180
	let excludedPid = argumentValue(after: "--exclude-pid").flatMap { Int32($0) }
	let requestedIds = Set(arguments.filter { $0.hasPrefix("window:") || $0.hasPrefix("display:") })

	let content: SCShareableContent
	do {
		content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
	} catch {
		fputs("THUMBNAIL_CONTENT_UNAVAILABLE \(error.localizedDescription)\n", stderr)
		return [:]
	}

	let excludedApplications = content.applications.filter { application in
		excludedPid != nil && application.processID == excludedPid
	}

	var jobs: [(String, SCContentFilter, CGRect)] = []
	for display in content.displays {
		let id = "display:\(display.displayID)"
		guard requestedIds.isEmpty || requestedIds.contains(id) else { continue }
		let filter = SCContentFilter(display: display, excludingApplications: excludedApplications, exceptingWindows: [])
		jobs.append((id, filter, display.frame))
	}
	for window in content.windows {
		let id = "window:\(window.windowID):0"
		guard requestedIds.isEmpty ? window.windowLayer == 0 : requestedIds.contains(id) else { continue }
		if let excludedPid, window.owningApplication?.processID == excludedPid { continue }
		guard window.frame.width >= 50, window.frame.height >= 50 else { continue }
		jobs.append((id, SCContentFilter(desktopIndependentWindow: window), window.frame))
	}

	return await withTaskGroup(of: (String, String?).self) { group in
		for (id, filter, frame) in jobs.prefix(64) {
			group.addTask {
				(id, await captureThumbnail(filter: filter, frame: frame, maxWidth: maxWidth, maxHeight: maxHeight))
			}
		}
		var result: [String: String] = [:]
		for await (id, dataURL) in group {
			if let dataURL {
				result[id] = dataURL
			}
		}
		return result
	}
}

if CommandLine.arguments.contains("--thumbnails") {
	var thumbnails: [String: String] = [:]
	if #available(macOS 14.0, *) {
		let semaphore = DispatchSemaphore(value: 0)
		Task {
			thumbnails = await captureThumbnails()
			semaphore.signal()
		}
		semaphore.wait()
	}
	let thumbnailEncoder = JSONEncoder()
	thumbnailEncoder.outputFormatting = [.sortedKeys]
	if let data = try? thumbnailEncoder.encode(thumbnails) {
		FileHandle.standardOutput.write(data)
	}
	exit(0)
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
