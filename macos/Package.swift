// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PawnForgeLauncher",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "PawnForgeLauncher", targets: ["PawnForgeLauncher"])
    ],
    targets: [
        .executableTarget(name: "PawnForgeLauncher")
    ]
)
