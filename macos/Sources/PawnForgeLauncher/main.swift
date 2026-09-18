import AppKit
import Foundation

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let port = "4173"
    private var statusItem: NSStatusItem!
    private var serverProcess: Process?
    private var repositoryURL: URL?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.title = "♟"
        statusItem.button?.toolTip = "PawnForge Coach"
        rebuildMenu()

        repositoryURL = findRepository()
        if repositoryURL == nil {
            showAlert(title: "PawnForge folder not found", message: "Choose the PawnForge repository folder from the menu before starting the local engine.")
        } else {
            startServer()
        }
        rebuildMenu()
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }

    @objc private func chooseRepository() {
        let panel = NSOpenPanel()
        panel.title = "Choose the PawnForge repository"
        panel.message = "Select the folder containing server.js and engine/."
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard isRepository(url) else {
            showAlert(title: "Invalid PawnForge folder", message: "The selected folder does not contain server.js.")
            return
        }
        repositoryURL = url
        startServer()
        rebuildMenu()
    }

    @objc private func startServer() {
        guard serverProcess == nil || serverProcess?.isRunning == false else { return }
        guard let repositoryURL else {
            chooseRepository()
            return
        }
        guard let nodePath = findNode() else {
            showAlert(title: "Node.js not found", message: "Install Node.js 18 or newer, then start PawnForge again.")
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [repositoryURL.appendingPathComponent("server.js").path]
        process.currentDirectoryURL = repositoryURL
        var environment = ProcessInfo.processInfo.environment
        environment["PORT"] = port
        process.environment = environment
        process.standardOutput = FileHandle.standardOutput
        process.standardError = FileHandle.standardError

        do {
            try process.run()
            serverProcess = process
        } catch {
            showAlert(title: "PawnForge did not start", message: error.localizedDescription)
        }
        rebuildMenu()
    }

    @objc private func stopServer() {
        guard let process = serverProcess, process.isRunning else {
            serverProcess = nil
            rebuildMenu()
            return
        }
        process.terminate()
        serverProcess = nil
        rebuildMenu()
    }

    @objc private func openPawnForge() {
        guard let url = URL(string: "http://127.0.0.1:\(port)/") else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func openChromeExtensions() {
        guard let url = URL(string: "googlechrome://extensions") else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func rebuildMenu() {
        let menu = NSMenu()
        let status = serverProcess?.isRunning == true ? "PawnForge running on port \(port)" : "PawnForge stopped"
        let statusItem = NSMenuItem(title: status, action: nil, keyEquivalent: "")
        statusItem.isEnabled = false
        menu.addItem(statusItem)
        menu.addItem(.separator())

        let startItem = NSMenuItem(title: "Start local engine", action: #selector(startServer), keyEquivalent: "s")
        startItem.target = self
        startItem.isEnabled = serverProcess?.isRunning != true
        menu.addItem(startItem)

        let stopItem = NSMenuItem(title: "Stop local engine", action: #selector(stopServer), keyEquivalent: "")
        stopItem.target = self
        stopItem.isEnabled = serverProcess?.isRunning == true
        menu.addItem(stopItem)

        let chooseItem = NSMenuItem(title: "Choose PawnForge folder...", action: #selector(chooseRepository), keyEquivalent: "o")
        chooseItem.target = self
        menu.addItem(chooseItem)

        menu.addItem(.separator())
        let appItem = NSMenuItem(title: "Open PawnForge", action: #selector(openPawnForge), keyEquivalent: "")
        appItem.target = self
        appItem.isEnabled = serverProcess?.isRunning == true
        menu.addItem(appItem)

        let chromeItem = NSMenuItem(title: "Open Chrome extensions", action: #selector(openChromeExtensions), keyEquivalent: "")
        chromeItem.target = self
        menu.addItem(chromeItem)

        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: "Quit PawnForge", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        statusItem.menu = menu
    }

    private func findRepository() -> URL? {
        let environment = ProcessInfo.processInfo.environment
        if let configured = environment["PAWNFORGE_ROOT"] {
            let url = URL(fileURLWithPath: configured).standardizedFileURL
            if isRepository(url) { return url }
        }
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "--repo"), arguments.indices.contains(index + 1) {
            let url = URL(fileURLWithPath: arguments[index + 1]).standardizedFileURL
            if isRepository(url) { return url }
        }
        let current = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).standardizedFileURL
        return isRepository(current) ? current : nil
    }

    private func isRepository(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.appendingPathComponent("server.js").path)
    }

    private func findNode() -> String? {
        let fileManager = FileManager.default
        let pathEntries = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        let candidates = pathEntries.map { "\($0)/node" } + [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node"
        ]
        return candidates.first { fileManager.isExecutableFile(atPath: $0) }
    }

    private func showAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}

@MainActor
func main() {
    let application = NSApplication.shared
    let delegate = AppDelegate()
    application.delegate = delegate
    application.run()
}

main()
