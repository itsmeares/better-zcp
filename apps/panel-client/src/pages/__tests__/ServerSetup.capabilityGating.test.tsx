import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "@/lib/routerCompat";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SocketContext } from "@/contexts/SocketContext";
import type { Socket } from "socket.io-client";
import ServerSetup from "../ServerSetup";
import { configApi, serverApi, serversApi } from "@/lib/api";
import enServerSetup from "../../locales/en/serverSetup.json";


class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;

Element.prototype.scrollIntoView = vi.fn();

let mockCan = (_capability: string) => true;

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "someone", role: "technician", capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => "fake-token",
    can: (capability: string) => mockCan(capability),
  }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    apiFetch: vi.fn().mockResolvedValue({ ok: false } as Response),
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn().mockResolvedValue({ settings: {} }),
      updateAppSettings: vi.fn(),
    },
    debugApi: { ...actual.debugApi, getRam: vi.fn().mockRejectedValue(new Error("no RAM info in test env")) },
    serverApi: { ...actual.serverApi, start: vi.fn(), getBranches: vi.fn().mockResolvedValue({ branches: [] }) },
    serversApi: { ...actual.serversApi, create: vi.fn(), activate: vi.fn() },
  };
});

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}));

const updateAppSettings = vi.mocked(configApi.updateAppSettings);
const start = vi.mocked(serverApi.start);
const create = vi.mocked(serversApi.create);
const activate = vi.mocked(serversApi.activate);

function createFakeSocket() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const socket = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler);
    }),
    emit: vi.fn(),
  };
  return {
    socket: socket as unknown as Socket,
    trigger: (event: string, data?: unknown) => {
      listeners.get(event)?.forEach((h) => h(data));
    },
  };
}

function renderServerSetup(socket: Socket | null = null) {
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={socket}>
        <TooltipProvider>
          <ServerSetup />
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("ServerSetup.tsx: Save SteamCMD path gates on panel.settings, not server.install", () => {
  async function openManualSteamCmdSection() {
    renderServerSetup();
    fireEvent.click(screen.getByText(enServerSetup.modeSelect.fullCard.title, { selector: "h3" }));
    await screen.findByText(enServerSetup.full.step1.title);
    fireEvent.click(screen.getByRole("button", { name: enServerSetup.full.step1.manualTrigger }));
    const pathInput = await screen.findByPlaceholderText(enServerSetup.full.step1.manualPathPlaceholder);
    fireEvent.change(pathInput, { target: { value: "/opt/steamcmd" } });
    return screen.getByRole("button", { name: enServerSetup.full.step1.savePathButton });
  }

  it("disables Save Path and never calls the API when the role holds server.install but lacks panel.settings (the stock TECHNICIAN case)", async () => {
    mockCan = (capability) => capability !== "panel.settings";
    const saveButton = await openManualSteamCmdSection();

    expect(saveButton).toBeDisabled();
    fireEvent.click(saveButton);
    expect(updateAppSettings).not.toHaveBeenCalled();
  });

  it("enables Save Path and calls the API when the role holds panel.settings", async () => {
    mockCan = () => true;
    updateAppSettings.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof configApi.updateAppSettings>>);
    const saveButton = await openManualSteamCmdSection();

    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);
    await waitFor(() => expect(updateAppSettings).toHaveBeenCalledWith({ steamcmdPath: "/opt/steamcmd" }));
  });

  it("leaves the auto-download button gated on server.install alone, unaffected by a panel.settings denial", async () => {
    mockCan = (capability) => capability !== "panel.settings";
    renderServerSetup();
    fireEvent.click(screen.getByText(enServerSetup.modeSelect.fullCard.title, { selector: "h3" }));
    await screen.findByText(enServerSetup.full.step1.title);

    const downloadButton = screen.getByRole("button", { name: enServerSetup.full.step1.installButton });
    expect(downloadButton).not.toBeDisabled();
  });
});

describe("ServerSetup.tsx: Start Server Now (shared by both post-install completion screens) gates on server.control", () => {
  async function reachQuickPostCreate() {
    const { socket, trigger } = createFakeSocket();
    const { container } = renderServerSetup(socket);

    fireEvent.click(screen.getByText(enServerSetup.modeSelect.quickCard.title, { selector: "h3" }));
    await screen.findByText(enServerSetup.quick.step1.title);
    fireEvent.change(screen.getByPlaceholderText(enServerSetup.quick.step1.locationPlaceholder), {
      target: { value: "/opt/pz-server" },
    });
    fireEvent.click(screen.getByRole("button", { name: enServerSetup.common.nextStepButton }));

    await screen.findByText(enServerSetup.quick.step2.title);
    fireEvent.change(screen.getByPlaceholderText(enServerSetup.common.serverNamePlaceholder), {
      target: { value: "myserver" },
    });
    const passwordInputs = container.querySelectorAll('input[type="password"]');
    expect(passwordInputs.length).toBe(2);
    fireEvent.change(passwordInputs[0], { target: { value: "rconpass123" } });
    fireEvent.change(passwordInputs[1], { target: { value: "adminpass123" } });
    fireEvent.click(screen.getByRole("button", { name: enServerSetup.common.nextStepButton }));

    await screen.findByText(enServerSetup.quick.step3.title);

    create.mockResolvedValue({ server: { id: 1 } } as Awaited<ReturnType<typeof serversApi.create>>);
    activate.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof serversApi.activate>>);
    trigger("install:complete", {
      success: true,
      serverName: "myserver",
      installPath: "/opt/pz-server",
      rconPort: 27015,
      rconPassword: "rconpass123",
      serverPort: 16261,
      minMemory: 4096,
      maxMemory: 8192,
      branch: "public",
    });

    return screen.findByRole("button", { name: enServerSetup.common.startServerButton });
  }

  it("disables Start Server Now and never calls the API when the role lacks server.control", async () => {
    mockCan = (capability) => capability !== "server.control";
    const startButton = await reachQuickPostCreate();

    expect(startButton).toBeDisabled();
    fireEvent.click(startButton);
    expect(start).not.toHaveBeenCalled();
  });

  it("enables Start Server Now and calls the API when the role holds server.control", async () => {
    mockCan = () => true;
    start.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof serverApi.start>>);
    const startButton = await reachQuickPostCreate();

    expect(startButton).not.toBeDisabled();
    fireEvent.click(startButton);
    await waitFor(() => expect(start).toHaveBeenCalled());
  });
});
