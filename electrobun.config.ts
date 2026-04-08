import pkg from "./package.json";

export default {
  app: {
    name: "Hermes Agent",
    identifier: "dev.davirain.hermes-agent-gui",
    version: pkg.version,
  },
  build: {
    views: {
      mainview: {
        entrypoint: "src/mainview/index.ts",
        external: [],
      },
      setup: {
        entrypoint: "src/mainview/setup.ts",
        external: [],
      },
    },
    copy: {
      "src/mainview/index.inline.html": "views/mainview/index.html",
      "src/mainview/index.css": "views/mainview/index.css",
      "src/mainview/setup.inline.html": "views/setup/setup.html",
      "src/mainview/setup.css": "views/setup/setup.css",
      "python": "python",
    },
    mac: {
      bundleCEF: false,
    },
    win: {
      bundleCEF: false,
    },
  },
};
