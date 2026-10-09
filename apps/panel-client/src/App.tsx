import { serversApi } from "./lib/api";
import { getSelectedServerId, selectServer } from "./lib/serverSelection";
import { Outlet, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback, Suspense } from "react";
import type { Socket } from "socket.io-client";
import Layout from "./components/Layout";
import {
  SocketContext,
  ConnectionStatus,
  ConnectionStatusContext,
} from "./contexts/SocketContext";
import { ConfirmProvider } from "./contexts/ConfirmContext";
import { useAuth } from "./contexts/AuthContext";
import { isDemoMode } from "./lib/demo";
import { toastManager } from "./components/ui/toast";
import { PageLoading } from "./components/PageLoading";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { ScrollToTop } from "./components/ScrollToTop";
import { getUserErrorMessage } from "./lib/errorMessage";
import { createSocketAuthProvider } from "./lib/socketAuth";
import { registerReconnectRecovery } from "./lib/socketRecovery";

function AppContent({
  onServersChanged,
}: {
  onServersChanged: () => Promise<void>;
}) {
  const serverId = getSelectedServerId();
  const demoMode = isDemoMode();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    connected: false,
    reconnecting: false,
    reconnectAttempt: 0,
    error: null,
  });
  const { getToken } = useAuth();

  const handleReconnectSuccess = useCallback(() => {
    toastManager.add({ title: "Reconnected", description: "The connection to the panel is back.", type: "success" });
  }, []);

  useEffect(() => {
    if (demoMode) return;

    let cancelled = false;
    let createdSocket: Socket | null = null;
    let disposeRecovery: (() => void) | null = null;

    const setupSocket = async () => {
      const { io } = await import("socket.io-client");
      if (cancelled) return;

      const newSocket = io(window.location.origin, {
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        autoConnect: false,
      });
      createdSocket = newSocket;
      newSocket.auth = createSocketAuthProvider(getToken, serverId);
      newSocket.connect();

      newSocket.on("servers:changed", onServersChanged);
      newSocket.on("connect", () => {
        void onServersChanged();
        disposeRecovery?.();
        disposeRecovery = null;
        setConnectionStatus((prev) => {
          if (prev.reconnecting || prev.reconnectAttempt > 0) {
            handleReconnectSuccess();
          }
          return {
            connected: true,
            reconnecting: false,
            reconnectAttempt: 0,
            error: null,
          };
        });
        newSocket.emit("subscribe:status");
        newSocket.emit("subscribe:players");
        newSocket.emit("subscribe:logs");
      });

      newSocket.on("disconnect", (reason) => {
        setConnectionStatus((prev) => ({
          ...prev,
          connected: false,
          error:
            reason === "io server disconnect"
              ? "Server closed connection"
              : null,
        }));
      });

      newSocket.on("connect_error", (err) => {
        if (newSocket.active) {
          setConnectionStatus((prev) => ({
            ...prev,
            connected: false,
            reconnecting: true,
            error: getUserErrorMessage(err, "Connection error"),
          }));
        } else {
          setConnectionStatus({
            connected: false,
            reconnecting: false,
            reconnectAttempt: 0,
            error: getUserErrorMessage(err, "Connection error"),
          });
        }
      });

      newSocket.io.on("reconnect_attempt", (attempt) => {
        setConnectionStatus((prev) => ({
          ...prev,
          reconnecting: true,
          reconnectAttempt: attempt,
        }));
      });

      newSocket.io.on("reconnect_failed", () => {
        setConnectionStatus({
          connected: false,
          reconnecting: false,
          reconnectAttempt: 0,
          error: "Failed to reconnect after multiple attempts",
        });
        toastManager.add({
          title: "Connection lost",
          description: "The panel stopped retrying. It tries again when this tab is visible or the network is back, or use Retry in the connection status.",
          type: "error",
          timeout: 15000,
        });

        disposeRecovery?.();
        disposeRecovery = registerReconnectRecovery(() => newSocket.connect());
      });

      setSocket(newSocket);
    };

    void setupSocket();

    return () => {
      cancelled = true;
      disposeRecovery?.();
      createdSocket?.close();
    };
  }, [
    handleReconnectSuccess,
    getToken,
    demoMode,
    serverId,
    onServersChanged,
  ]);

  return (
    <ConnectionStatusContext.Provider value={connectionStatus}>
      <SocketContext.Provider value={socket}>
        <Layout>
          <ScrollToTop />
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </Layout>
      </SocketContext.Provider>
    </ConnectionStatusContext.Provider>
  );
}

function ServerGate() {
  const { server: serverId } = useSearch({ from: "__root__" });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const validateSelection = useCallback(async () => {
    try {
      const { servers } = await serversApi.getAll();
      if (getSelectedServerId() !== (serverId ?? null)) return;
      // Pick the first server on load, or when the selected one is gone. Once
      // the app runs without a selection, a new server doesn't take over: the
      // switch would remount the page, such as the add-server flow mid-finish.
      const keep = serverId ? servers.some((server) => String(server.id) === serverId) : loadedRef.current;
      const next = keep ? (serverId ?? null) : (servers[0]?.id ?? null);
      if ((next ?? null) !== (serverId ?? null)) {
        await selectServer(next ?? null);
        return;
      }
      setError(null);
      loadedRef.current = true;
      setReady(true);
    } catch (error) {
      setError(getUserErrorMessage(error, "Could not load servers"));
    }
  }, [serverId]);
  useEffect(() => {
    void validateSelection();
  }, [validateSelection]);
  if (error)
    return (
      <div className="mx-auto max-w-lg p-6">
        <Alert variant="error">
          <AlertTitle>Could not load your servers</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => window.location.reload()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      </div>
    );
  if (!ready)
    return (
      <div className="mx-auto max-w-7xl p-6">
        <PageLoading />
      </div>
    );
  return (
    <ConfirmProvider>
      <AppContent onServersChanged={validateSelection} />
    </ConfirmProvider>
  );
}

function App() {
  const { server } = useSearch({ from: "__root__" });
  return <ServerGate key={server ?? "panel"} />;
}

export default App;
