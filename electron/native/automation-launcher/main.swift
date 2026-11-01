import Foundation
import Darwin

func fail(_ message: String, code: Int32 = 3) -> Never {
    FileHandle.standardError.write(Data(("screendance: \(message)\n").utf8))
    exit(code)
}

var executablePathSize: UInt32 = 0
_NSGetExecutablePath(nil, &executablePathSize)
var executablePathBuffer = [CChar](repeating: 0, count: Int(executablePathSize))
guard _NSGetExecutablePath(&executablePathBuffer, &executablePathSize) == 0 else { fail("Cannot resolve the bundled launcher path.") }
let executable = URL(fileURLWithPath: String(cString: executablePathBuffer)).resolvingSymlinksInPath()
let contents = executable.deletingLastPathComponent().deletingLastPathComponent()
let bundle = contents.deletingLastPathComponent()
let infoURL = contents.appendingPathComponent("Info.plist")
guard let data = try? Data(contentsOf: infoURL),
      let info = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
      let name = info["CFBundleExecutable"] as? String,
      !name.isEmpty, !name.contains("/"), name != executable.lastPathComponent else {
    fail("Run the CLI installed inside Screendance App.app, or reinstall its link.")
}
let runtime = contents.appendingPathComponent("MacOS").appendingPathComponent(name)
let script = contents.appendingPathComponent("Resources/automation/screendance.mjs")
guard FileManager.default.isExecutableFile(atPath: runtime.path),
      FileManager.default.fileExists(atPath: script.path) else {
    fail("The bundled automation runtime is missing; reinstall Screendance App.")
}
setenv("ELECTRON_RUN_AS_NODE", "1", 1)
setenv("SCREENDANCE_APP_BUNDLE", bundle.path, 1)
setenv("SCREENDANCE_CLI_PATH", executable.path, 1)
let arguments = [runtime.path, script.path] + Array(CommandLine.arguments.dropFirst())
let strings = arguments.map { strdup($0) } + [nil]
strings.withUnsafeBufferPointer { buffer in
    _ = execv(runtime.path, buffer.baseAddress!)
}
fail("Cannot start bundled runtime: \(String(cString: strerror(errno)))")
