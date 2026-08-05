const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    asar: true,
    prune: true,
    icon: './icon', // Forge añade automáticamente la extensión (.ico en Windows)
    appBundleId: "com.labelgrup.verentia",
    executableName: "VerentiaIP",
    // Forge packages the working directory as it is on disk, NOT what git tracks,
    // so .gitignore does not protect anything here.
    //
    // Every dot-entry at the project root is excluded as a class rather than
    // enumerated, because the enumerated list kept going stale as new tooling
    // added directories. Concretely it covers: .codegraph/ (whose daemon.sock is
    // a unix socket, and the packager aborts outright with "Cannot copy a socket
    // file"), .claude/ and .superpowers/ (local agent config and internal review
    // notes containing shop-floor IPs), .DS_Store, and a future .env — which
    // holds the GITHUB_TOKEN used for publishing and must never ship.
    //
    // Nothing the app needs at runtime is hidden: main.js, preload.js,
    // splash.html and icon.png are all at the root unprefixed.
    ignore: [
      /^\/\.[^/]+($|\/)/,
      /^\/(docs|test|tests|publish\.js)($|\/)/
    ]
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: "VerentiaIP",
        setupExe: "VerentiaIP-Setup.exe", // Nombre más estándar
        setupIcon: "./icon.ico",
        noMsi: true,
        compressionLevel: 9,
        outputDirectory: "out",
        // Configuración adicional para Windows
        authors: "LabelGrup Networks",
        description: "Aplicación para mostrar la IP"
      }
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
      config: {
        name: "VerentiaIP-mac-x64.zip"
      }
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        name: "verentia-ip",
        productName: "VerentiaIP",
        maintainer: "LabelGrup Networks",
        homepage: "https://github.com/labelgrupnetworks/02384_SGA_Electron"
      }
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        name: "verentia-ip",
        productName: "VerentiaIP",
        maintainer: "LabelGrup Networks",
        homepage: "https://github.com/labelgrupnetworks/02384_SGA_Electron"
      }
    }
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'labelgrupnetworks',
          name: '02384_SGA_Electron'
        },
        prerelease: false,
        draft: false,
        // Genera automáticamente las release notes desde los commits
        generateReleaseNotes: true
      }
    }
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {}
    },
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true
    })
  ]
};