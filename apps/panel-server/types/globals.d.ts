declare const PANEL_VERSION: string | undefined;
declare const PANEL_BUILD_SHA: string | undefined;
declare const PANEL_API_CONTRACT_VERSION: number | undefined;
declare const PANEL_BRIDGE_LUA_B64: string | undefined;
declare const PANEL_CLIENT_DIST_B64: string | undefined;

declare namespace NodeJS {
  interface Process {
    pkg?: unknown;
  }
}
