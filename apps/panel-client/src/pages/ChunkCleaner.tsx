import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  Map,
  Trash2,
  RefreshCw,
  AlertTriangle,
  Save,
  ZoomIn,
  ZoomOut,
  Move,
  Square,
  Info,
  Database,
  FileBox,
  Maximize,
  Image,
  ImageOff,
  FolderOpen,
  Car,
  Home,
  CheckCircle2,
  XCircle,
  HelpCircle,
  ShieldAlert,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HelpTip } from "@/components/HelpTip";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/use-toast";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { chunksApi, serversApi, panelBridgeApi, mapApi, ApiError } from "@/lib/api";
import { buildTileQuery } from "./worldMapTileUrl";
import { getUserErrorMessage } from "@/lib/errorMessage";
import { useTheme } from "@/contexts/ThemeContext";
import { useSocket } from "@/contexts/SocketContext";
import { useAuth } from "@/contexts/AuthContext";
import { DisabledReason } from "@/components/DisabledReason";
import { platformTranslationKey, useRuntimeInfo } from "@/hooks/useRuntimeInfo";

interface SaveInfo {
  name: string;
  modified: string;
  chunkCount: number;
  size: number;
  sizeFormatted: string;
}

interface ChunkInfo {
  file: string;
  x: number;
  y: number;
  size: number;
  modified: string;
  source?: string;
  cellX?: number;
  cellY?: number;
}

interface ChunkBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface SaveStats {
  saveName: string;
  totalSize: number;
  totalSizeFormatted: string;
  folders: Record<
    string,
    { fileCount: number; size: number; sizeFormatted: string }
  >;
  playersDbSize?: number;
  vehiclesDbSize?: number;
}

interface ChunkVehicle {
  id: number;
  x: number;
  y: number;
  type: string;
  scriptName: string;
  fuelPct: number;
}

interface ChunkSafehouse {
  id: string;
  title: string;
  owner: string;
  x: number;
  y: number;
  w: number;
  h: number;
  players: string[];
  playerConnected: boolean;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 60;
const MIN_FIT_SCALE = 2;
const MAP_TILE_SIZE = 100;
const MAP_TILES_CDN = "https://grabofus.github.io/zomboid-chunk-cleaner/assets";

const B42_DZI_CDN = "/api/map/toptiles";
const B42_DZI_FULL_W = 19968;
const B42_DZI_FULL_H = 16128;
const B42_DZI_TILE_PX = 256;
const B42_DZI_MAX_LEVEL = 15;
const B42_CHUNK_TO_DZI_PX = 8;

const PZ_LANDMARKS: {
  name: string;
  x: number;
  y: number;
  b42Only?: boolean;
}[] = [
  { name: "Muldraugh", x: 1063, y: 980 },
  { name: "West Point", x: 1190, y: 690 },
  { name: "Rosewood", x: 809, y: 1150 },
  { name: "Riverside", x: 610, y: 540 },
  { name: "Louisville", x: 1270, y: 170 },
  { name: "March Ridge", x: 1010, y: 1270 },
  { name: "Valley Station", x: 1320, y: 530 },
  { name: "Ekron", x: 55, y: 975, b42Only: true },
  { name: "Brandenburg", x: 210, y: 608, b42Only: true },
  { name: "Irvington", x: 250, y: 1425, b42Only: true },
  { name: "Echo Creek", x: 352, y: 1093, b42Only: true },
  { name: "Fallas Lake", x: 728, y: 835, b42Only: true },
  { name: "Louisville Airport", x: 1544, y: 294, b42Only: true },
];

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function decomposeIntoRectangles(
  selectedChunks: Set<string>,
): Array<{ minX: number; minY: number; maxX: number; maxY: number }> {
  const rowsMap = new globalThis.Map<number, number[]>();
  for (const key of selectedChunks) {
    const [xStr, yStr] = key.split("_");
    const x = Number(xStr);
    const y = Number(yStr);
    const row = rowsMap.get(y);
    if (row) row.push(x);
    else rowsMap.set(y, [x]);
  }

  const strips: Array<{ y: number; xStart: number; xEnd: number }> = [];
  for (const [y, xsRaw] of rowsMap) {
    const xs = [...xsRaw].sort((a, b) => a - b);
    let runStart = xs[0];
    let prev = xs[0];
    for (let i = 1; i <= xs.length; i++) {
      const cur = xs[i];
      if (cur === prev + 1) {
        prev = cur;
        continue;
      }
      strips.push({ y, xStart: runStart, xEnd: prev });
      if (cur !== undefined) {
        runStart = cur;
        prev = cur;
      }
    }
  }

  const byRange = new globalThis.Map<string, number[]>();
  for (const s of strips) {
    const k = `${s.xStart}_${s.xEnd}`;
    const ys = byRange.get(k);
    if (ys) ys.push(s.y);
    else byRange.set(k, [s.y]);
  }
  const rects: Array<{ minX: number; minY: number; maxX: number; maxY: number }> = [];
  for (const [k, ysRaw] of byRange) {
    const [xStart, xEnd] = k.split("_").map(Number);
    const ys = [...ysRaw].sort((a, b) => a - b);
    let runStart = ys[0];
    let prev = ys[0];
    for (let i = 1; i <= ys.length; i++) {
      const cur = ys[i];
      if (cur === prev + 1) {
        prev = cur;
        continue;
      }
      rects.push({ minX: xStart, minY: runStart, maxX: xEnd, maxY: prev });
      if (cur !== undefined) {
        runStart = cur;
        prev = cur;
      }
    }
  }
  return rects;
}

const MAX_VEHICLE_REMOVAL_RECTS = 40;

function findFirstRenderableChunkIndex(
  chunks: ChunkInfo[],
  minX: number,
): number {
  let low = 0;
  let high = chunks.length;
  const target = minX - 1;

  while (low < high) {
    const mid = (low + high) >> 1;
    if (chunks[mid].x < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function findLastRenderableChunkIndex(
  chunks: ChunkInfo[],
  maxX: number,
): number {
  let low = 0;
  let high = chunks.length;

  while (low < high) {
    const mid = (low + high) >> 1;
    if (chunks[mid].x <= maxX) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low - 1;
}

export default function ChunkCleaner() {
  const { t, i18n } = useTranslation("chunkCleaner");
  const runtimeInfo = useRuntimeInfo();
  const { theme } = useTheme();
  const socket = useSocket();
  const { can } = useAuth();
  const canManageChunks = can("chunks.manage");
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [saves, setSaves] = useState<SaveInfo[]>([]);
  const [selectedSave, setSelectedSave] = useState<string>("");
  const [chunks, setChunks] = useState<ChunkInfo[]>([]);
  const [bounds, setBounds] = useState<ChunkBounds | null>(null);
  const [stats, setStats] = useState<SaveStats | null>(null);
  const [scanServerId, setScanServerId] = useState<string | number | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState<{
    scanned: number;
    total: number;
    chunks: number;
  } | null>(null);
  const [loadingSaves, setLoadingSaves] = useState(true);
  const [selectedChunks, setSelectedChunks] = useState<Set<string>>(new Set());
  const { toast } = useToast();

  const [customPath, setCustomPath] = useState<string>("");
  const [customPathInput, setCustomPathInput] = useState<string>("");
  const [debugInfo, setDebugInfo] = useState<{
    zomboidDataPath?: string | null;
    savesPath?: string | null;
    exists?: boolean;
    usedCustomPath?: boolean;
    autoPicked?: string | null;
    hint?: string | null;
    attempted?: string[];
    suggestedPaths?: Array<{
      path: string;
      exists: boolean;
      hasSaves: boolean;
    }>;
    errorCode?: string;
    rejection?: {
      reason?:
        | "not-found"
        | "not-a-directory"
        | "stat-failed"
        | "install-folder"
        | "no-zomboid-markers";
      tried?: string;
      parentSuggestion?: string | null;
      checks?: Record<string, boolean>;
    };
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  const canvasColorsRef = useRef({
    bg: "228 30% 7%",
    primary: "217 91% 60%",
    destructive: "0 70% 50%",
    mutedFg: "215 14% 55%",
    foreground: "210 11% 90%",
    warning: "28 80% 55%",
    accent: "34 55% 28%",
  });

  useEffect(() => {
    const el = canvasRef.current ?? document.documentElement;
    const style = getComputedStyle(el);
    const get = (name: string) => style.getPropertyValue(name).trim();
    canvasColorsRef.current = {
      bg: get("--background") || "228 30% 7%",
      primary: get("--primary") || "217 91% 60%",
      destructive: get("--destructive") || "0 70% 50%",
      mutedFg: get("--muted-foreground") || "215 14% 55%",
      foreground: get("--foreground") || "210 11% 90%",
      warning: get("--warning") || "28 80% 55%",
      accent: get("--accent") || "34 55% 28%",
    };
  }, [theme]);

  const [scale, setScale] = useState(4);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const [tool, setTool] = useState<"select" | "pan">("select");
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0, ox: 0, oy: 0 });
  const [selectionStart, setSelectionStart] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const hoverWorldRef = useRef<{ x: number; y: number } | null>(null);
  const drawRequestRef = useRef(0);

  const [showMap, setShowMap] = useState(true);
  const tileCacheRef = useRef<Record<string, HTMLImageElement | null>>({});
  const tileLoadCountRef = useRef(0);

  const [showCustomPath, setShowCustomPath] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const loadIdRef = useRef(0);

  const [isB42Save, setIsB42Save] = useState(false);
  const isB42Ref = useRef(false);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [createBackup, setCreateBackup] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [deleteVehicles, setDeleteVehicles] = useState(true);

  const [serverRunningDialog, setServerRunningDialog] = useState<{
    open: boolean;
    matched: Array<{ pid?: string; cmd: string }>;
    resolve?: (force: boolean) => void;
  }>({ open: false, matched: [] });

  const [chunkVehicles, setChunkVehicles] = useState<ChunkVehicle[]>([]);
  const [chunkSafehouses, setChunkSafehouses] = useState<ChunkSafehouse[]>([]);
  const [showVehicles, setShowVehicles] = useState(true);
  const [showSafehouses, setShowSafehouses] = useState(true);

  const chunkMap = useMemo(() => {
    const lookup: Record<string, ChunkInfo> = {};
    for (const chunk of chunks) lookup[`${chunk.x}_${chunk.y}`] = chunk;
    return lookup;
  }, [chunks]);

  const selectedSize = useMemo(() => {
    let total = 0;
    for (const key of selectedChunks) {
      const chunk = chunkMap[key];
      if (chunk) total += chunk.size || 0;
    }
    return total;
  }, [chunkMap, selectedChunks]);

  const hasCanvas = !!selectedSave && !loading && chunks.length > 0;
  const hasSaves = saves.length > 0;
  const activePathLabel =
    customPath || debugInfo?.zomboidDataPath || t("activePathDefaultLabel");

  const screenToWorld = useCallback(
    (sx: number, sy: number) => ({
      x: (sx - offset.x) / scale,
      y: (sy - offset.y) / scale,
    }),
    [scale, offset],
  );

  const getCanvasMousePos = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    },
    [],
  );

  const fetchSaves = useCallback(
    async (pathOverride?: string) => {
      setLoadingSaves(true);
      setLoadError(null);
      try {
        const pathToUse = pathOverride ?? (customPath || undefined);
        const result = await chunksApi.getSaves(pathToUse);
        setPermissionDenied(false);
        setSaves(result.saves || []);
        setDebugInfo(result.debug ?? null);
        if (
          result.debug?.hint &&
          (!result.saves || result.saves.length === 0)
        ) {
          setLoadError(result.debug.hint);
        }
        return result.saves || [];
      } catch (error) {
        const apiErr = error instanceof ApiError ? error : null;
        if (apiErr?.status === 403) {
          setPermissionDenied(true);
          return [];
        }
        const payload = (apiErr?.data ?? null) as {
          debug?: NonNullable<typeof debugInfo>;
        } | null;
        const message =
          (error instanceof Error && error.message) ||
          t("toasts.loadSavesFailedFallback");
        setLoadError(message);
        if (payload?.debug) setDebugInfo(payload.debug);
        toast({
          title: t("toasts.loadSavesFailedTitle"),
          description: message,
          variant: "destructive",
        });
        if (!payload?.debug) {
          try {
            const suggested = await chunksApi.suggestedPaths();
            setDebugInfo(
              (prev) =>
                prev ?? {
                  suggestedPaths: suggested?.candidates ?? [],
                  hint: message,
                },
            );
          } catch {
            /* best-effort */
          }
        }
        return [];
      } finally {
        setLoadingSaves(false);
      }
    },
    [customPath, toast, t],
  );

  useEffect(() => {
    (async () => {
      const savesList = await fetchSaves();
      if (savesList.length === 0) return;

      let picked = false;
      try {
        const { server } = await serversApi.getResolvedActive();
        if (server?.serverName) {
          const match = savesList.find(
            (s: SaveInfo) => s.name === server.serverName,
          );
          if (match) {
            setSelectedSave(match.name);
            picked = true;
          }
        }
      } catch {
        // No active server configured — fall through to auto-pick below
      }

      if (!picked) {
        setSelectedSave(savesList[0].name);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (saves.length === 0) return;
    if (selectedSave && saves.some((s) => s.name === selectedSave)) return;
    setSelectedSave(saves[0].name);
  }, [saves, selectedSave]);

  const applyCustomPath = useCallback(async () => {
    const nextPath = customPathInput.trim();
    if (!nextPath) return;
    setCustomPath(nextPath);
    setSelectedSave("");
    await fetchSaves(nextPath);
  }, [customPathInput, fetchSaves]);

  const resetToDefaultPath = useCallback(async () => {
    setCustomPath("");
    setCustomPathInput("");
    setSelectedSave("");
    setDebugInfo(null);
    await fetchSaves("");
  }, [fetchSaves]);

  const applySuggestedPath = useCallback(
    async (suggested: string) => {
      setCustomPathInput(suggested);
      setCustomPath(suggested);
      setSelectedSave("");
      setShowCustomPath(true);
      await fetchSaves(suggested);
    },
    [fetchSaves],
  );

  const [savingPath, setSavingPath] = useState(false);
  const persistCurrentPath = useCallback(
    async (pathToSave: string) => {
      if (!pathToSave) return;
      if (!canManageChunks) return;
      setSavingPath(true);
      try {
        const result = await chunksApi.savePath(pathToSave);
        toast({
          title: t("toasts.pathSavedTitle"),
          description:
            result.target === "server"
              ? t("toasts.pathSavedServerDesc")
              : t("toasts.pathSavedPanelDesc"),
        });
        setCustomPath("");
        setCustomPathInput("");
        await fetchSaves("");
      } catch (error) {
        const message =
          (error instanceof Error && error.message) ||
          t("toasts.pathSaveFailedFallback");
        toast({
          title: t("toasts.pathSaveFailedTitle"),
          description: message,
          variant: "destructive",
        });
      } finally {
        setSavingPath(false);
      }
    },
    [fetchSaves, toast, t, canManageChunks],
  );

  const loadChunks = useCallback(async () => {
    if (!selectedSave) return;
    const thisLoadId = ++loadIdRef.current;
    setLoading(true);
    setScanProgress(null);
    setChunks([]);
    setBounds(null);
    setStats(null);
    setSelectedChunks(new Set());
    setChunkVehicles([]);
    setChunkSafehouses([]);
    setScanServerId(null);

    const scanId = `${thisLoadId}-${Date.now().toString(36)}`;
    const handleProgress = (p: {
      scanId: string;
      scanned: number;
      total: number;
      chunks: number;
    }) => {
      if (p.scanId !== scanId || thisLoadId !== loadIdRef.current) return;
      setScanProgress({ scanned: p.scanned, total: p.total, chunks: p.chunks });
    };
    socket?.on("chunkScan:progress", handleProgress);

    try {
      const pathToUse = customPath || undefined;
      const [chunksSettled, statsSettled] = await Promise.allSettled([
        chunksApi.getChunks(selectedSave, pathToUse, scanId),
        chunksApi.getStats(selectedSave, pathToUse),
      ]);

      if (thisLoadId !== loadIdRef.current) return;

      if (chunksSettled.status === "rejected") {
        throw chunksSettled.reason;
      }
      const chunksResult = chunksSettled.value;
      const statsResult =
        statsSettled.status === "fulfilled" ? statsSettled.value : null;

      const rawChunks: ChunkInfo[] = Array.isArray(chunksResult.chunks)
        ? chunksResult.chunks
        : [];
      const isB42 =
        chunksResult.isB42 === true ||
        (rawChunks.length > 0 && rawChunks[0].file?.includes("/"));
      isB42Ref.current = isB42;
      setIsB42Save(isB42);
      setChunks(rawChunks);
      setBounds(chunksResult.bounds ?? null);
      setStats(statsResult);
      setScanServerId(chunksResult.resolvedServerId ?? null);
    } catch (error) {
      if (thisLoadId !== loadIdRef.current) return;
      toast({
        title: t("toasts.errorTitle"),
        description: getUserErrorMessage(error, t("toasts.loadChunksFailedFallback")),
        variant: "destructive",
      });
    } finally {
      socket?.off("chunkScan:progress", handleProgress);
      if (thisLoadId === loadIdRef.current) {
        setLoading(false);
        setScanProgress(null);
      }
    }
  }, [selectedSave, customPath, toast, socket, t]);

  const invalidateStaleScan = useCallback(() => {
    loadIdRef.current += 1;
    setChunks([]);
    setBounds(null);
    setStats(null);
    setSelectedChunks(new Set());
    setChunkVehicles([]);
    setChunkSafehouses([]);
    setScanServerId(null);
    setSelectedSave("");
    setSaves([]);
    setDeleteDialogOpen(false);
    toast({
      title: t("toasts.activeServerChangedTitle"),
      description: t("toasts.activeServerChangedDesc"),
      variant: "destructive",
    });
    void fetchSaves();
  }, [fetchSaves, t, toast]);

  useEffect(() => {
    if (!socket || customPath) return;
    const handleActiveServerChanged = () => invalidateStaleScan();
    socket.on("activeServerChanged", handleActiveServerChanged);
    return () => {
      socket.off("activeServerChanged", handleActiveServerChanged);
    };
  }, [socket, customPath, invalidateStaleScan]);

  const fetchOverlayData = useCallback(async () => {
    const thisLoadId = loadIdRef.current;
    try {
      const [vRes, sRes] = await Promise.allSettled([
        panelBridgeApi.sendCommand("getVehiclesDetailed"),
        panelBridgeApi.sendCommand("getSafehouses"),
      ]);
      if (thisLoadId !== loadIdRef.current) return;
      if (
        vRes.status === "fulfilled" &&
        vRes.value.success &&
        vRes.value.data
      ) {
        const vData = vRes.value.data as Record<string, unknown>;
        const vList = (
          Array.isArray(vData)
            ? vData
            : Array.isArray(vData.vehicles)
              ? vData.vehicles
              : []
        ) as Record<string, unknown>[];
        const tilesPerChunk = isB42Ref.current ? 8 : 10;
        setChunkVehicles(
          vList
            .filter(
              (v) =>
                typeof v.x === "number" &&
                typeof v.y === "number" &&
                isFinite(v.x as number) &&
                isFinite(v.y as number),
            )
            .map((v) => ({
              id: v.id as number,
              x: Math.floor((v.x as number) / tilesPerChunk),
              y: Math.floor((v.y as number) / tilesPerChunk),
              type:
                (v.type as string) ||
                (v.scriptName as string)?.split(".").pop() ||
                "Vehicle",
              scriptName: (v.scriptName as string) || "",
              fuelPct: typeof v.fuelPct === "number" ? v.fuelPct : -1,
            })),
        );
      }
      if (
        sRes.status === "fulfilled" &&
        sRes.value.success &&
        sRes.value.data
      ) {
        const sData = sRes.value.data as Record<string, unknown>;
        const sList = (
          Array.isArray(sData)
            ? sData
            : Array.isArray(sData.safehouses)
              ? sData.safehouses
              : []
        ) as Record<string, unknown>[];
        const tilesPerChunk = isB42Ref.current ? 8 : 10;
        setChunkSafehouses(
          sList
            .filter(
              (s) =>
                typeof s.x === "number" &&
                typeof s.y === "number" &&
                isFinite(s.x as number) &&
                isFinite(s.y as number),
            )
            .map((s) => ({
              id: s.id as string,
              title: (s.title as string) || "",
              owner: (s.owner as string) || "",
              x: Math.floor((s.x as number) / tilesPerChunk),
              y: Math.floor((s.y as number) / tilesPerChunk),
              w: Math.max(1, Math.ceil(((s.w as number) || 1) / tilesPerChunk)),
              h: Math.max(1, Math.ceil(((s.h as number) || 1) / tilesPerChunk)),
              players: Array.isArray(s.players) ? (s.players as string[]) : [],
              playerConnected: (s.playerConnected as boolean) || false,
            })),
        );
      }
    } catch {
      /* best-effort */
    }
  }, []);

  useEffect(() => {
    if (selectedSave) {
      loadChunks().then(() => fetchOverlayData());
    }
  }, [selectedSave, loadChunks, fetchOverlayData]);

  const fitView = useCallback(() => {
    if (!chunks.length) return;

    let W = canvasSize.width;
    let H = canvasSize.height;
    if (W === 0 || H === 0) {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      W = Math.floor(rect.width);
      H = Math.floor(rect.height);
      if (W === 0 || H === 0) return;
      setCanvasSize({ width: W, height: H });
    }

    const xs = chunks.map((c) => c.x).sort((a, b) => a - b);
    const ys = chunks.map((c) => c.y).sort((a, b) => a - b);
    const p5 = Math.floor(chunks.length * 0.02);
    const p95 = Math.min(chunks.length - 1, Math.floor(chunks.length * 0.98));
    const fitMinX = xs[p5];
    const fitMaxX = xs[p95];
    const fitMinY = ys[p5];
    const fitMaxY = ys[p95];

    const rangeX = fitMaxX - fitMinX + 1;
    const rangeY = fitMaxY - fitMinY + 1;
    const padding = 50;
    const fitScale = Math.min(
      (W - padding * 2) / rangeX,
      (H - padding * 2) / rangeY,
    );
    const newScale = Math.max(MIN_FIT_SCALE, Math.min(MAX_SCALE, fitScale));
    const centerX = (fitMinX + fitMaxX + 1) / 2;
    const centerY = (fitMinY + fitMaxY + 1) / 2;
    setScale(newScale);
    setOffset({
      x: W / 2 - centerX * newScale,
      y: H / 2 - centerY * newScale,
    });
  }, [chunks, canvasSize]);

  const hasAutoFittedRef = useRef(false);

  useEffect(() => {
    hasAutoFittedRef.current = false;
  }, [selectedSave]);

  useEffect(() => {
    if (hasAutoFittedRef.current) return;
    if (chunks.length === 0) return;
    if (canvasSize.width === 0 || canvasSize.height === 0) return;
    const id = requestAnimationFrame(() => {
      hasAutoFittedRef.current = true;
      fitView();
    });
    return () => cancelAnimationFrame(id);
  }, [chunks, canvasSize, fitView]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setCanvasSize({
            width: Math.floor(width),
            height: Math.floor(height),
          });
        }
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [hasCanvas]);

  const MAX_TILE_CACHE = 512;
  const loadMapTile = useCallback((tileX: number, tileY: number) => {
    const key = `${tileX}_${tileY}`;
    if (key in tileCacheRef.current) return;
    const keys = Object.keys(tileCacheRef.current);
    if (keys.length >= MAX_TILE_CACHE) {
      const toRemove = keys.slice(0, keys.length - MAX_TILE_CACHE + 64);
      for (const k of toRemove) delete tileCacheRef.current[k];
    }
    tileCacheRef.current[key] = null;
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      tileCacheRef.current[key] = img;
      tileLoadCountRef.current++;
      if (drawRequestRef.current === 0) {
        drawRequestRef.current = requestAnimationFrame(() => {
          drawRequestRef.current = 0;
          drawCanvasRef.current();
        });
      }
    };
    img.onerror = () => {
      /* tile missing, keep null */
    };
    img.src = `${MAP_TILES_CDN}/map_${tileX}_${tileY}.png`;
  }, []);

  const dziCacheRef = useRef<Record<string, HTMLImageElement | null | false>>({});
  const b42DirRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    mapApi
      .resolve()
      .then((info) => {
        if (!cancelled) b42DirRef.current = info.b42Dir;
      })
      .catch(() => {
        /* tiles just keep using the shorter unversioned cache window */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const loadDziTile = useCallback((level: number, col: number, row: number) => {
    const key = `dzi_${level}_${col}_${row}`;
    if (key in dziCacheRef.current) return;
    const keys = Object.keys(dziCacheRef.current);
    if (keys.length >= MAX_TILE_CACHE) {
      const toRemove = keys.slice(0, keys.length - MAX_TILE_CACHE + 64);
      for (const k of toRemove) delete dziCacheRef.current[k];
    }
    dziCacheRef.current[key] = null;
    const img = new window.Image();
    img.onload = () => {
      dziCacheRef.current[key] = img;
      if (drawRequestRef.current === 0) {
        drawRequestRef.current = requestAnimationFrame(() => {
          drawRequestRef.current = 0;
          drawCanvasRef.current();
        });
      }
    };
    img.onerror = () => {
      dziCacheRef.current[key] = false;
      if (drawRequestRef.current === 0) {
        drawRequestRef.current = requestAnimationFrame(() => {
          drawRequestRef.current = 0;
          drawCanvasRef.current();
        });
      }
    };
    img.src = `${B42_DZI_CDN}/${level}/${col}_${row}.webp${buildTileQuery(0, b42DirRef.current)}`;
  }, []);

  const drawCanvasRef = useRef<() => void>(() => {});

  const scheduleDraw = useCallback(() => {
    if (drawRequestRef.current) return;
    drawRequestRef.current = requestAnimationFrame(() => {
      drawRequestRef.current = 0;
      drawCanvasRef.current();
    });
  }, []);

  useEffect(() => {
    drawCanvasRef.current = () => {
      const canvas = canvasRef.current;
      if (!canvas || canvasSize.width === 0 || canvasSize.height === 0) return;

      canvas.width = canvasSize.width;
      canvas.height = canvasSize.height;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const W = canvasSize.width;
      const H = canvasSize.height;

      const cc = canvasColorsRef.current;
      const bgVar = cc.bg;
      const primaryVar = cc.primary;
      const destructiveVar = cc.destructive;
      const mutedFgVar = cc.mutedFg;
      const foregroundVar = cc.foreground;
      const warningVar = cc.warning;
      const accentVar = cc.accent;
      const hsl = (v: string, a: number) => `hsl(${v} / ${a})`;

      const canvasBg = bgVar ? `hsl(${bgVar})` : hsl("228 30% 7%", 1);

      ctx.fillStyle = canvasBg;
      ctx.fillRect(0, 0, W, H);

      if (!bounds || chunks.length === 0) return;

      const visMinX = Math.floor(-offset.x / scale) - 1;
      const visMaxX = Math.ceil((W - offset.x) / scale) + 1;
      const visMinY = Math.floor(-offset.y / scale) - 1;
      const visMaxY = Math.ceil((H - offset.y) / scale) + 1;

      if (showMap) {
        ctx.save();
        ctx.globalAlpha = 0.6;

        if (isB42Save) {
          const idealLevel =
            B42_DZI_MAX_LEVEL -
            Math.log2(B42_CHUNK_TO_DZI_PX / Math.max(scale, 0.01));
          const level = Math.max(
            0,
            Math.min(B42_DZI_MAX_LEVEL, Math.round(idealLevel)),
          );
          const levelScale = Math.pow(2, B42_DZI_MAX_LEVEL - level);

          const levelW = Math.ceil(B42_DZI_FULL_W / levelScale);
          const levelH = Math.ceil(B42_DZI_FULL_H / levelScale);
          const numCols = Math.ceil(levelW / B42_DZI_TILE_PX);
          const numRows = Math.ceil(levelH / B42_DZI_TILE_PX);

          const pixMinX = (visMinX * B42_CHUNK_TO_DZI_PX) / levelScale;
          const pixMinY = (visMinY * B42_CHUNK_TO_DZI_PX) / levelScale;
          const pixMaxX = (visMaxX * B42_CHUNK_TO_DZI_PX) / levelScale;
          const pixMaxY = (visMaxY * B42_CHUNK_TO_DZI_PX) / levelScale;

          const colMin = Math.max(0, Math.floor(pixMinX / B42_DZI_TILE_PX));
          const colMax = Math.min(
            numCols - 1,
            Math.floor(pixMaxX / B42_DZI_TILE_PX),
          );
          const rowMin = Math.max(0, Math.floor(pixMinY / B42_DZI_TILE_PX));
          const rowMax = Math.min(
            numRows - 1,
            Math.floor(pixMaxY / B42_DZI_TILE_PX),
          );

          const chunkPerDziPx = levelScale / B42_CHUNK_TO_DZI_PX;

          for (let row = rowMin; row <= rowMax; row++) {
            for (let col = colMin; col <= colMax; col++) {
              loadDziTile(level, col, row);
              const img = dziCacheRef.current[`dzi_${level}_${col}_${row}`];
              if (img || img === false) {
                const tileChunkX = col * B42_DZI_TILE_PX * chunkPerDziPx;
                const tileChunkY = row * B42_DZI_TILE_PX * chunkPerDziPx;
                const actualTileW = Math.min(
                  B42_DZI_TILE_PX,
                  levelW - col * B42_DZI_TILE_PX,
                );
                const actualTileH = Math.min(
                  B42_DZI_TILE_PX,
                  levelH - row * B42_DZI_TILE_PX,
                );
                const chunkW = actualTileW * chunkPerDziPx;
                const chunkH = actualTileH * chunkPerDziPx;

                const sx = tileChunkX * scale + offset.x;
                const sy = tileChunkY * scale + offset.y;
                const sw = chunkW * scale;
                const sh = chunkH * scale;
                if (img) {
                  ctx.drawImage(img, sx, sy, sw, sh);
                } else {
                  ctx.fillStyle = hsl(mutedFgVar, 0.08);
                  ctx.fillRect(sx, sy, sw, sh);
                }
              }
            }
          }
        } else {
          const minTX = Math.floor(visMinX / MAP_TILE_SIZE);
          const maxTX = Math.floor(visMaxX / MAP_TILE_SIZE);
          const minTY = Math.floor(visMinY / MAP_TILE_SIZE);
          const maxTY = Math.floor(visMaxY / MAP_TILE_SIZE);

          for (let ty = minTY; ty <= maxTY; ty++) {
            for (let tx = minTX; tx <= maxTX; tx++) {
              loadMapTile(tx, ty);
              const img = tileCacheRef.current[`${tx}_${ty}`];
              if (img) {
                const sx = tx * MAP_TILE_SIZE * scale + offset.x;
                const sy = ty * MAP_TILE_SIZE * scale + offset.y;
                const sw = MAP_TILE_SIZE * scale;
                ctx.drawImage(img, sx, sy, sw, sw);
              }
            }
          }
        }

        ctx.restore();
      }

      if (showMap && !isB42Save && scale > 1) {
        const tileGridMinX =
          Math.floor(visMinX / MAP_TILE_SIZE) * MAP_TILE_SIZE;
        const tileGridMaxX = Math.ceil(visMaxX / MAP_TILE_SIZE) * MAP_TILE_SIZE;
        const tileGridMinY =
          Math.floor(visMinY / MAP_TILE_SIZE) * MAP_TILE_SIZE;
        const tileGridMaxY = Math.ceil(visMaxY / MAP_TILE_SIZE) * MAP_TILE_SIZE;

        ctx.strokeStyle = hsl(primaryVar, 0.25);
        ctx.lineWidth = 1;
        for (let x = tileGridMinX; x <= tileGridMaxX; x += MAP_TILE_SIZE) {
          const sx = Math.floor(x * scale + offset.x) + 0.5;
          if (sx >= 0 && sx <= W) {
            ctx.beginPath();
            ctx.moveTo(sx, 0);
            ctx.lineTo(sx, H);
            ctx.stroke();
          }
        }
        for (let y = tileGridMinY; y <= tileGridMaxY; y += MAP_TILE_SIZE) {
          const sy = Math.floor(y * scale + offset.y) + 0.5;
          if (sy >= 0 && sy <= H) {
            ctx.beginPath();
            ctx.moveTo(0, sy);
            ctx.lineTo(W, sy);
            ctx.stroke();
          }
        }
      }

      {
        const markerSize = Math.max(6, Math.min(14, scale * 3));
        const fontSize = Math.max(9, Math.min(13, scale * 2.5));
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";

        for (const lm of PZ_LANDMARKS) {
          if (lm.b42Only && !isB42Save) continue;
          const lx = isB42Save ? lm.x * 1.25 : lm.x;
          const ly = isB42Save ? lm.y * 1.25 : lm.y;
          const sx = lx * scale + offset.x;
          const sy = ly * scale + offset.y;
          if (sx < -100 || sx > W + 100 || sy < -50 || sy > H + 50) continue;

          const half = markerSize / 2;
          ctx.fillStyle = hsl(primaryVar, 0.85);
          ctx.beginPath();
          ctx.moveTo(sx, sy - half);
          ctx.lineTo(sx + half, sy);
          ctx.lineTo(sx, sy + half);
          ctx.lineTo(sx - half, sy);
          ctx.closePath();
          ctx.fill();

          ctx.strokeStyle = hsl(foregroundVar, 0.7);
          ctx.lineWidth = 1;
          ctx.stroke();

          const labelX = sx + half + 4;
          const labelWidth = ctx.measureText(lm.name).width;
          const labelFits =
            labelX >= 0 &&
            labelX + labelWidth <= W &&
            sy - fontSize / 2 >= 0 &&
            sy + fontSize / 2 <= H;
          if (labelFits) {
            ctx.fillStyle = hsl(bgVar || "0 0% 0%", 0.6);
            ctx.fillText(lm.name, labelX + 1, sy + 1);
            ctx.fillStyle = hsl(foregroundVar, 0.95);
            ctx.fillText(lm.name, labelX, sy);
          }
        }
      }

      if (showSafehouses && chunkSafehouses.length > 0) {
        for (const sh of chunkSafehouses) {
          const sx = sh.x * scale + offset.x;
          const sy = sh.y * scale + offset.y;
          const sw = sh.w * scale;
          const shh = sh.h * scale;

          if (sx + sw < 0 || sx > W || sy + shh < 0 || sy > H) continue;

          ctx.fillStyle = sh.playerConnected
            ? `hsl(120 60% 40% / 0.15)`
            : `hsl(120 40% 50% / 0.08)`;
          ctx.fillRect(sx, sy, sw, shh);

          ctx.strokeStyle = sh.playerConnected
            ? `hsl(120 60% 50% / 0.7)`
            : `hsl(120 40% 50% / 0.4)`;
          ctx.lineWidth = sh.playerConnected ? 2 : 1;
          ctx.setLineDash([4, 3]);
          ctx.strokeRect(sx, sy, sw, shh);
          ctx.setLineDash([]);

          if (sw > 30 && shh > 20) {
            const label = sh.title || sh.owner || t("canvasLabels.safehouseFallback");
            const shFontSize = Math.max(8, Math.min(11, scale * 2));
            ctx.font = `bold ${shFontSize}px sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillStyle = `hsl(120 50% 65% / 0.85)`;
            ctx.fillText(label, sx + sw / 2, sy + shh / 2);
          }
        }
      }

      if (showVehicles && chunkVehicles.length > 0) {
        const vSize = Math.max(2, Math.min(6, scale * 0.8));

        for (const v of chunkVehicles) {
          const vx = (v.x + 0.5) * scale + offset.x;
          const vy = (v.y + 0.5) * scale + offset.y;

          if (vx < -10 || vx > W + 10 || vy < -10 || vy > H + 10) continue;

          const vColor =
            v.fuelPct < 0
              ? hsl(primaryVar, 0.5)
              : v.fuelPct > 30
                ? hsl(primaryVar, 0.7)
                : v.fuelPct > 10
                  ? hsl(warningVar, 0.8)
                  : hsl(destructiveVar, 0.8);

          ctx.beginPath();
          ctx.arc(vx, vy, vSize, 0, Math.PI * 2);
          ctx.fillStyle = vColor;
          ctx.fill();
          ctx.strokeStyle = hsl(foregroundVar, 0.4);
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }

        if (scale > 2) {
          const vLabel = t("canvasLabels.vehicleCount", {
            count: chunkVehicles.length,
          });
          ctx.font = "10px sans-serif";
          ctx.textAlign = "right";
          ctx.textBaseline = "top";
          const vm = ctx.measureText(vLabel);
          ctx.fillStyle = hsl(bgVar || "0 0% 0%", 0.7);
          ctx.fillRect(W - vm.width - 16, 26, vm.width + 12, 16);
          ctx.fillStyle = hsl(primaryVar, 0.7);
          ctx.fillText(vLabel, W - 10, 29);
        }
      }

      if (scale > 4) {
        ctx.strokeStyle = hsl(foregroundVar, 0.06);
        ctx.lineWidth = 1;

        const gridMinX = Math.max(bounds.minX, visMinX);
        const gridMaxX = Math.min(bounds.maxX + 1, visMaxX);
        const gridMinY = Math.max(bounds.minY, visMinY);
        const gridMaxY = Math.min(bounds.maxY + 1, visMaxY);

        for (let x = gridMinX; x <= gridMaxX; x++) {
          const sx = Math.floor(x * scale + offset.x) + 0.5;
          if (sx >= 0 && sx <= W) {
            ctx.beginPath();
            ctx.moveTo(sx, 0);
            ctx.lineTo(sx, H);
            ctx.stroke();
          }
        }
        for (let y = gridMinY; y <= gridMaxY; y++) {
          const sy = Math.floor(y * scale + offset.y) + 0.5;
          if (sy >= 0 && sy <= H) {
            ctx.beginPath();
            ctx.moveTo(0, sy);
            ctx.lineTo(W, sy);
            ctx.stroke();
          }
        }
      }

      const visibleStart = findFirstRenderableChunkIndex(chunks, visMinX);
      const visibleEnd = findLastRenderableChunkIndex(chunks, visMaxX);

      for (let index = visibleStart; index <= visibleEnd; index++) {
        const chunk = chunks[index];
        if (
          chunk.x + 1 < visMinX ||
          chunk.x > visMaxX ||
          chunk.y + 1 < visMinY ||
          chunk.y > visMaxY
        )
          continue;

        const sx = chunk.x * scale + offset.x;
        const sy = chunk.y * scale + offset.y;
        const key = `${chunk.x}_${chunk.y}`;
        const isSelected = selectedChunks.has(key);
        const sz = Math.max(scale, 1);

        if (isSelected) {
          ctx.fillStyle = hsl(destructiveVar, 0.5);
        } else {
          const ratio = Math.min(chunk.size / 50000, 1);
          ctx.fillStyle =
            ratio > 0.5
              ? hsl(warningVar, 0.25 + ratio * 0.15)
              : hsl(accentVar, 0.2 + ratio * 0.2);
        }

        if (scale > 4) {
          const gap = Math.max(0.5, scale * 0.06);
          ctx.fillRect(sx + gap, sy + gap, scale - gap * 2, scale - gap * 2);
          if (isSelected) {
            ctx.strokeStyle = hsl(destructiveVar, 0.8);
          } else {
            const ratio = Math.min(chunk.size / 50000, 1);
            ctx.strokeStyle =
              ratio > 0.5
                ? hsl(warningVar, 0.5 + ratio * 0.2)
                : hsl(accentVar, 0.4 + ratio * 0.2);
          }
          ctx.lineWidth = 1;
          ctx.strokeRect(sx + gap, sy + gap, scale - gap * 2, scale - gap * 2);
        } else {
          ctx.fillRect(sx, sy, sz, sz);
        }
      }

      if (bounds) {
        const bx = bounds.minX * scale + offset.x;
        const by = bounds.minY * scale + offset.y;
        const bw = (bounds.maxX - bounds.minX + 1) * scale;
        const bh = (bounds.maxY - bounds.minY + 1) * scale;
        ctx.strokeStyle = hsl(warningVar, 0.5);
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(bx, by, bw, bh);
        ctx.setLineDash([]);
      }

      if (scale > 18) {
        const fontSize = Math.min(10, scale * 0.5);
        ctx.font = `${fontSize}px monospace`;
        ctx.fillStyle = hsl(mutedFgVar, 0.6);

        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        for (
          let x = Math.max(bounds.minX, visMinX);
          x <= Math.min(bounds.maxX, visMaxX);
          x++
        ) {
          const sx = (x + 0.5) * scale + offset.x;
          if (sx >= 0 && sx <= W) {
            const tickY = bounds.minY * scale + offset.y - 3;
            if (tickY > -20 && tickY < H) ctx.fillText(x.toString(), sx, tickY);
          }
        }
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        for (
          let y = Math.max(bounds.minY, visMinY);
          y <= Math.min(bounds.maxY, visMaxY);
          y++
        ) {
          const sy = (y + 0.5) * scale + offset.y;
          if (sy >= 0 && sy <= H) {
            const tickX = bounds.minX * scale + offset.x - 4;
            if (tickX > -60 && tickX < W) ctx.fillText(y.toString(), tickX, sy);
          }
        }
      }

      if (selectionStart && selectionEnd) {
        const wsx = Math.min(selectionStart.x, selectionEnd.x);
        const wsy = Math.min(selectionStart.y, selectionEnd.y);
        const wex = Math.max(selectionStart.x, selectionEnd.x);
        const wey = Math.max(selectionStart.y, selectionEnd.y);

        const s1x = selectionStart.x * scale + offset.x;
        const s1y = selectionStart.y * scale + offset.y;
        const s2x = selectionEnd.x * scale + offset.x;
        const s2y = selectionEnd.y * scale + offset.y;

        const rx = Math.min(s1x, s2x);
        const ry = Math.min(s1y, s2y);
        const rw = Math.abs(s2x - s1x);
        const rh = Math.abs(s2y - s1y);

        ctx.fillStyle = hsl(primaryVar, 0.15);
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = hsl(primaryVar, 1);
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.setLineDash([]);

        let selCount = 0;
        const selectionStartIndex = findFirstRenderableChunkIndex(chunks, wsx);
        const selectionEndIndex = findLastRenderableChunkIndex(
          chunks,
          Math.ceil(wex) - 1,
        );
        for (
          let index = selectionStartIndex;
          index <= selectionEndIndex;
          index++
        ) {
          const c = chunks[index];
          if (c.x + 1 > wsx && c.x < wex && c.y + 1 > wsy && c.y < wey)
            selCount++;
        }

        if (selCount > 0 && rw > 30) {
          const selLabel = t("canvasLabels.selectionCount", { count: selCount });
          ctx.font = "11px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          const mx = rx + rw / 2;
          const lm = ctx.measureText(selLabel);
          ctx.fillStyle = hsl(primaryVar, 0.9);
          const pw = lm.width + 10;
          ctx.fillRect(mx - pw / 2, ry - 18, pw, 16);
          ctx.fillStyle = hsl(foregroundVar, 1);
          ctx.fillText(selLabel, mx, ry - 4);
        }
      }

      const hover = hoverWorldRef.current;
      if (hover) {
        const hx = Math.floor(hover.x);
        const hy = Math.floor(hover.y);
        const shx = hx * scale + offset.x;
        const shy = hy * scale + offset.y;

        ctx.strokeStyle = hsl(foregroundVar, 0.5);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(shx, shy, scale, scale);
      }

      ctx.font = "11px monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";

      if (hover) {
        const hx = Math.floor(hover.x);
        const hy = Math.floor(hover.y);
        const hkey = `${hx}_${hy}`;
        const hoverChunk = chunkMap[hkey];
        const hoverSel = selectedChunks.has(hkey);

        const chunksPerCell = isB42Save ? 32 : 30;
        const cellX = Math.floor(hx / chunksPerCell);
        const cellY = Math.floor(hy / chunksPerCell);
        let label = t("canvasLabels.chunkCell", { cx: hx, cy: hy, gx: cellX, gy: cellY });
        if (hoverChunk) {
          label += ` | ${formatSize(hoverChunk.size)}${hoverSel ? ` | ${t("canvasLabels.selected")}` : ""}`;
        }

        const metrics = ctx.measureText(label);
        ctx.fillStyle = hsl(bgVar || "0 0% 0%", 0.85);
        ctx.fillRect(6, H - 22, metrics.width + 12, 18);
        ctx.fillStyle = hsl(foregroundVar, 0.85);
        ctx.fillText(label, 12, H - 8);
      }

      ctx.textAlign = "right";
      const zLabel = t("canvasLabels.pxPerChunk", { scale: scale.toFixed(1) });
      const zm = ctx.measureText(zLabel);
      ctx.fillStyle = hsl(bgVar || "0 0% 0%", 0.7);
      ctx.fillRect(W - zm.width - 16, H - 22, zm.width + 12, 18);
      ctx.fillStyle = hsl(mutedFgVar, 0.7);
      ctx.fillText(zLabel, W - 10, H - 8);

      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const chunksPerCell = isB42Save ? 32 : 30;
      const cellMinX = Math.floor(bounds.minX / chunksPerCell);
      const cellMinY = Math.floor(bounds.minY / chunksPerCell);
      const cellMaxX = Math.floor(bounds.maxX / chunksPerCell);
      const cellMaxY = Math.floor(bounds.maxY / chunksPerCell);
      const boundsLabel = t("canvasLabels.boundsLabel", {
        minX: bounds.minX,
        maxX: bounds.maxX,
        minY: bounds.minY,
        maxY: bounds.maxY,
        count: chunks.length,
        cellMinX,
        cellMaxX,
        cellMinY,
        cellMaxY,
      });
      const bm = ctx.measureText(boundsLabel);
      ctx.fillStyle = hsl(bgVar || "0 0% 0%", 0.7);
      ctx.fillRect(6, 6, bm.width + 12, 18);
      ctx.fillStyle = hsl(mutedFgVar, 0.7);
      ctx.fillText(boundsLabel, 12, 9);

      if (showMap) {
        const mapLabel = isB42Save
          ? t("canvasLabels.mapB42")
          : t("canvasLabels.mapB41");
        const mm = ctx.measureText(mapLabel);
        ctx.fillStyle = hsl(bgVar || "0 0% 0%", 0.7);
        ctx.fillRect(6, 26, mm.width + 12, 18);
        ctx.fillStyle = hsl(mutedFgVar, 0.7);
        ctx.fillText(mapLabel, 12, 29);
      }
    };

    scheduleDraw();
  }, [
    chunks,
    chunkMap,
    bounds,
    scale,
    offset,
    selectedChunks,
    selectionStart,
    selectionEnd,
    canvasSize,
    showMap,
    loadMapTile,
    loadDziTile,
    isB42Save,
    showVehicles,
    showSafehouses,
    chunkVehicles,
    chunkSafehouses,
    t,
    scheduleDraw,
  ]);

  useEffect(() => {
    return () => {
      if (drawRequestRef.current) {
        cancelAnimationFrame(drawRequestRef.current);
        drawRequestRef.current = 0;
      }
    };
  }, []);

  useEffect(() => {
    if (!hasCanvas) return;
    const container = containerRef.current;
    if (!container) return;
    const preventScroll = (e: WheelEvent) => {
      e.preventDefault();
    };
    container.addEventListener("wheel", preventScroll, { passive: false });
    return () => container.removeEventListener("wheel", preventScroll);
  }, [hasCanvas]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if (deleteDialogOpen) return;
      if (!selectedSave) return;

      switch (e.key) {
        case "Escape":
          setSelectionStart(null);
          setSelectionEnd(null);
          setSelectedChunks(new Set());
          break;
        case "Delete":
          if (selectedChunks.size > 0 && canManageChunks) {
            setDeleteVehicles(true);
            setDeleteDialogOpen(true);
          }
          break;
        case "1":
          setTool("select");
          break;
        case "2":
          setTool("pan");
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedChunks.size, deleteDialogOpen, selectedSave, canManageChunks]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const pos = getCanvasMousePos(e);

      if (tool === "pan" || e.button === 1 || e.button === 2) {
        isPanningRef.current = true;
        panStartRef.current = {
          x: pos.x,
          y: pos.y,
          ox: offset.x,
          oy: offset.y,
        };
      } else if (tool === "select" && e.button === 0) {
        const world = screenToWorld(pos.x, pos.y);
        setSelectionStart(world);
        setSelectionEnd(world);
      }
    },
    [tool, offset, getCanvasMousePos, screenToWorld],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const pos = getCanvasMousePos(e);
      const world = screenToWorld(pos.x, pos.y);
      hoverWorldRef.current = world;

      if (isPanningRef.current) {
        const dx = pos.x - panStartRef.current.x;
        const dy = pos.y - panStartRef.current.y;
        setOffset({
          x: panStartRef.current.ox + dx,
          y: panStartRef.current.oy + dy,
        });
      } else if (selectionStart) {
        setSelectionEnd(world);
      } else {
        scheduleDraw();
      }
    },
    [selectionStart, getCanvasMousePos, screenToWorld, scheduleDraw],
  );

  const commitSelection = useCallback(
    (shiftKey: boolean) => {
      if (!selectionStart || !selectionEnd) return;

      const sx = Math.min(selectionStart.x, selectionEnd.x);
      const sy = Math.min(selectionStart.y, selectionEnd.y);
      const ex = Math.max(selectionStart.x, selectionEnd.x);
      const ey = Math.max(selectionStart.y, selectionEnd.y);

      const isClick = Math.abs(ex - sx) < 0.5 && Math.abs(ey - sy) < 0.5;

      setSelectedChunks((prev) => {
        const newSelected = new Set(prev);

        if (isClick) {
          const cx = Math.floor((sx + ex) / 2);
          const cy = Math.floor((sy + ey) / 2);
          const key = `${cx}_${cy}`;
          if (chunkMap[key]) {
            if (shiftKey || prev.has(key)) {
              newSelected.delete(key);
            } else {
              newSelected.add(key);
            }
          }
        } else {
          const selectionStartIndex = findFirstRenderableChunkIndex(chunks, sx);
          const selectionEndIndex = findLastRenderableChunkIndex(
            chunks,
            Math.ceil(ex) - 1,
          );
          for (
            let index = selectionStartIndex;
            index <= selectionEndIndex;
            index++
          ) {
            const chunk = chunks[index];
            if (
              chunk.x + 1 > sx &&
              chunk.x < ex &&
              chunk.y + 1 > sy &&
              chunk.y < ey
            ) {
              const key = `${chunk.x}_${chunk.y}`;
              if (shiftKey) {
                newSelected.delete(key);
              } else {
                newSelected.add(key);
              }
            }
          }
        }

        return newSelected;
      });

      setSelectionStart(null);
      setSelectionEnd(null);
    },
    [selectionStart, selectionEnd, chunks, chunkMap],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (isPanningRef.current) {
        isPanningRef.current = false;
        return;
      }

      commitSelection(e.shiftKey);
    },
    [commitSelection],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      const pos = getCanvasMousePos(e);
      const factor = e.deltaY > 0 ? 0.88 : 1.14;
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));

      const worldX = (pos.x - offset.x) / scale;
      const worldY = (pos.y - offset.y) / scale;
      setScale(newScale);
      setOffset({
        x: pos.x - worldX * newScale,
        y: pos.y - worldY * newScale,
      });
    },
    [scale, offset, getCanvasMousePos],
  );

  const handleMouseLeave = useCallback(() => {
    hoverWorldRef.current = null;
    if (isPanningRef.current) {
      isPanningRef.current = false;
    }
    if (selectionStart && selectionEnd) {
      commitSelection(false);
    }
    scheduleDraw();
  }, [selectionStart, selectionEnd, commitSelection, scheduleDraw]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  const touchRef = useRef<{
    startX: number;
    startY: number;
    offX: number;
    offY: number;
    pinchDist: number | null;
    moveDist: number;
  }>({
    startX: 0,
    startY: 0,
    offX: 0,
    offY: 0,
    pinchDist: null,
    moveDist: 0,
  });

  const getTouchDist = (touches: React.TouchList) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length === 1) {
        touchRef.current = {
          startX: e.touches[0].clientX,
          startY: e.touches[0].clientY,
          offX: offset.x,
          offY: offset.y,
          pinchDist: null,
          moveDist: 0,
        };
        isPanningRef.current = true;
      } else if (e.touches.length === 2) {
        touchRef.current.pinchDist = getTouchDist(e.touches);
      }
    },
    [offset],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 2 && touchRef.current.pinchDist !== null) {
        const newDist = getTouchDist(e.touches);
        const factor = newDist / touchRef.current.pinchDist;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const cx =
          (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
        const newScale = Math.max(
          MIN_SCALE,
          Math.min(MAX_SCALE, scale * factor),
        );
        const worldX = (cx - offset.x) / scale;
        const worldY = (cy - offset.y) / scale;
        setScale(newScale);
        setOffset({ x: cx - worldX * newScale, y: cy - worldY * newScale });
        touchRef.current.pinchDist = newDist;
      } else if (e.touches.length === 1 && isPanningRef.current) {
        const t = e.touches[0];
        const tr = touchRef.current;
        const dx = t.clientX - tr.startX;
        const dy = t.clientY - tr.startY;
        tr.moveDist = Math.max(tr.moveDist, Math.sqrt(dx * dx + dy * dy));
        setOffset({ x: tr.offX + dx, y: tr.offY + dy });
      }
    },
    [scale, offset],
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const tr = touchRef.current;
      const wasTap =
        isPanningRef.current && tr.moveDist < 8 && tr.pinchDist === null;
      isPanningRef.current = false;
      touchRef.current = { ...tr, pinchDist: null, moveDist: 0 };

      if (wasTap && tool === "select") {
        const canvas = canvasRef.current;
        const ct = e.changedTouches[0];
        if (canvas && ct) {
          const rect = canvas.getBoundingClientRect();
          const sx = ct.clientX - rect.left;
          const sy = ct.clientY - rect.top;
          const world = {
            x: (sx - offset.x) / scale,
            y: (sy - offset.y) / scale,
          };
          const cx = Math.floor(world.x);
          const cy = Math.floor(world.y);
          const key = `${cx}_${cy}`;
          if (chunkMap[key]) {
            setSelectedChunks((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            });
          }
        }
      }
    },
    [tool, offset, scale, chunkMap],
  );

  const handleDelete = async () => {
    if (selectedChunks.size === 0) return;
    if (!canManageChunks) return;

    setDeleting(true);
    try {
      const chunksToDelete = chunks
        .filter((c) => selectedChunks.has(`${c.x}_${c.y}`))
        .map((c) => ({
          file: c.file,
          x: c.x,
          y: c.y,
          source: c.source,
          cellX: c.cellX,
          cellY: c.cellY,
        }));

      if (deleteVehicles) {
        const tilesPerChunk = isB42Ref.current ? 8 : 10;
        const rects = decomposeIntoRectangles(selectedChunks);
        if (rects.length > MAX_VEHICLE_REMOVAL_RECTS) {
          toast({
            title: t("toasts.liveVehicleCleanupTooFragmentedTitle"),
            description: t("toasts.liveVehicleCleanupTooFragmentedDesc"),
          });
        } else {
          for (const rect of rects) {
            try {
              await panelBridgeApi.sendCommand("removeVehiclesInArea", {
                minX: rect.minX * tilesPerChunk,
                minY: rect.minY * tilesPerChunk,
                maxX: (rect.maxX + 1) * tilesPerChunk,
                maxY: (rect.maxY + 1) * tilesPerChunk,
              });
            } catch (err) {
              if (err instanceof ApiError && err.status === 403) {
                toast({
                  title: t("toasts.liveVehicleCleanupNoPermissionTitle"),
                  description: t("toasts.liveVehicleCleanupNoPermissionDesc"),
                });
                break;
              }
            }
          }
        }
      }

      const tryDelete = async (force: boolean) =>
        chunksApi.deleteChunks(
          selectedSave,
          chunksToDelete,
          createBackup,
          customPath || undefined,
          deleteVehicles,
          force,
          scanServerId,
        );

      let result: Awaited<ReturnType<typeof tryDelete>>;
      try {
        result = await tryDelete(false);
      } catch (err) {
        if (err instanceof ApiError && err.code === "server_running") {
          const matched =
            (err.data && typeof err.data === "object" && "matched" in err.data
              ? (err.data as { matched?: Array<{ pid?: string; cmd: string }> })
                  .matched
              : []) || [];
          const userForced = await new Promise<boolean>((resolve) => {
            setServerRunningDialog({ open: true, matched, resolve });
          });
          if (!userForced) {
            toast({
              title: t("toasts.serverRunningTitle"),
              description: getUserErrorMessage(err, t("toasts.deleteChunksFailedFallback")),
              variant: "destructive",
            });
            return;
          }
          result = await tryDelete(true);
        } else {
          throw err;
        }
      }

      const vDel =
        (result as { vehiclesDeleted?: number }).vehiclesDeleted ?? 0;
      const deletedCount = result.deleted ?? 0;
      const failures = (result as { errors?: string[] }).errors ?? [];
      if (failures.length > 0) {
        toast({
          title: t("toasts.chunksDeletedPartialTitle"),
          description: t("toasts.chunksDeletedPartialDesc", {
            deleted: deletedCount,
            count: failures.length,
          }),
          variant: "destructive",
        });
      } else {
        toast({
          title: t("toasts.chunksDeletedTitle"),
          description:
            t("toasts.chunksDeletedDesc", { count: deletedCount }) +
            (vDel > 0 ? t("toasts.chunksDeletedVehicles", { count: vDel }) : "") +
            (createBackup ? t("toasts.chunksDeletedBackupSuffix") : ""),
        });
      }

      setDeleteDialogOpen(false);
      setSelectedChunks(new Set());
      setDeleteVehicles(true);
      await loadChunks();
      await fetchOverlayData();
    } catch (error) {
      if (error instanceof ApiError && error.code === "CHUNKS_STALE_SERVER_SCAN") {
        invalidateStaleScan();
      } else {
        toast({
          title: t("toasts.errorTitle"),
          description: getUserErrorMessage(error, t("toasts.deleteChunksFailedFallback")),
          variant: "destructive",
        });
      }
    } finally {
      setDeleting(false);
    }
  };

  const selectAll = () =>
    setSelectedChunks(new Set(chunks.map((c) => `${c.x}_${c.y}`)));
  const clearSelection = () => setSelectedChunks(new Set());
  const invertSelection = () => {
    const all = new Set(chunks.map((c) => `${c.x}_${c.y}`));
    const inverted = new Set<string>();
    for (const key of all) {
      if (!selectedChunks.has(key)) inverted.add(key);
    }
    setSelectedChunks(inverted);
  };

  return (
    <TooltipProvider>
      <div className="space-y-5 page-transition">
        <div className="space-y-3">
          <PageHeader
            title={t("pageHeader.title")}
            description={t("pageHeader.description")}
            icon={<Map className="w-5 h-5" />}
          />
          <p className="flex items-center gap-2 text-xs text-warning/90">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            {t("pageHeader.warning")}
          </p>
        </div>

        {permissionDenied ? (
          <EmptyState
            type="accessDenied"
            icon={<ShieldAlert className="h-14 w-14 text-muted-foreground/40" />}
            title={t("permissionDenied.title")}
            description={t("permissionDenied.description")}
          />
        ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-5">
          <div className="space-y-3 order-2 lg:order-1">
            <Card>
              <CardHeader className="px-4 py-3 pb-0">
                <CardTitle className="text-xs font-medium flex items-center gap-2 text-muted-foreground">
                  <Save className="w-3.5 h-3.5" />
                  {t("save.title")}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 pt-2 space-y-2.5">
                <Select value={selectedSave} onValueChange={setSelectedSave}>
                  <SelectTrigger disabled={loadingSaves} className="h-9">
                    <SelectValue
                      placeholder={
                        loadingSaves
                          ? t("save.placeholderLoading")
                          : t("save.placeholderChoose")
                      }
                    >
                      {selectedSave || undefined}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {saves.map((save) => {
                      let modifiedLabel = "";
                      if (save.modified) {
                        try {
                          const d = new Date(save.modified);
                          const ageDays =
                            (Date.now() - d.getTime()) / 86_400_000;
                          if (ageDays < 1) modifiedLabel = t("save.modifiedToday");
                          else if (ageDays < 2)
                            modifiedLabel = t("save.modifiedYesterday");
                          else if (ageDays < 30)
                            modifiedLabel = t("save.modifiedDaysAgo", {
                              count: Math.floor(ageDays),
                            });
                          else modifiedLabel = d.toLocaleDateString(i18n.language);
                        } catch {
                          /* leave empty */
                        }
                      }
                      return (
                        <SelectItem key={save.name} value={save.name}>
                          <div className="flex items-center justify-between gap-2 w-full">
                            <div className="flex flex-col min-w-0">
                              <span className="truncate">{save.name}</span>
                              {modifiedLabel && (
                                <span className="text-[10px] text-muted-foreground">
                                  {modifiedLabel}
                                </span>
                              )}
                            </div>
                            <Badge
                              variant="secondary"
                              className="ms-2 text-xs shrink-0"
                            >
                              {save.sizeFormatted}
                            </Badge>
                          </div>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>

                <Button
                  variant="outline"
                  size="sm"
                  className="w-full h-8 text-xs"
                  onClick={() => fetchSaves()}
                  disabled={loadingSaves}
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 me-1.5 ${loadingSaves ? "animate-spin" : ""}`}
                  />
                  {loadingSaves ? t("save.refreshing") : t("save.refresh")}
                </Button>

                <Collapsible
                  open={showCustomPath}
                  onOpenChange={setShowCustomPath}
                >
                  <CollapsibleTrigger asChild>
                    <button className="flex items-center gap-1.5 w-full text-[11px] text-muted-foreground/70 hover:text-muted-foreground transition-colors pt-1">
                      <FolderOpen className="w-3 h-3" />
                      <span>
                        {showCustomPath
                          ? t("save.customPathHide")
                          : t("save.customPathShow")}
                      </span>
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-2 pt-2">
                    <div className="flex gap-1.5">
                      <Input
                        value={customPathInput}
                        onChange={(e) => setCustomPathInput(e.target.value)}
                        placeholder={t(platformTranslationKey("save.customPathPlaceholder", runtimeInfo?.family))}
                        aria-label={t("save.customPathAria")}
                        className="text-xs h-7"
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && customPathInput.trim()) {
                            void applyCustomPath();
                          }
                        }}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 shrink-0 text-xs"
                        onClick={() => void applyCustomPath()}
                        disabled={!customPathInput.trim() || loadingSaves}
                      >
                        {t("save.load")}
                      </Button>
                    </div>
                    <p className="text-[10px] text-muted-foreground/80 leading-snug">
                      <Trans
                        i18nKey={platformTranslationKey("save.customPathHint", runtimeInfo?.family)}
                        t={t}
                        components={{
                          1: <span className="font-mono" />,
                          2: <span className="font-mono" />,
                          3: <span className="font-mono" />,
                          4: <span className="font-mono" />,
                        }}
                      />
                    </p>
                    {customPath && (
                      <div className="flex gap-1.5">
                        <DisabledReason reason={!canManageChunks ? t("permissions.noManage") : null}>
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1 h-6 text-[10px]"
                            onClick={() => void persistCurrentPath(customPath)}
                            disabled={savingPath || loadingSaves || !canManageChunks}
                            // eslint-disable-next-line local/no-dead-disabled-title -- pure hint describing what the button does; the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                            title={t("save.saveAsDefaultTitle")}
                          >
                            <Save className="w-3 h-3 me-1" />
                            {savingPath ? t("save.saving") : t("save.saveAsDefault")}
                          </Button>
                        </DisabledReason>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="flex-1 h-6 text-[10px] text-muted-foreground"
                          onClick={() => void resetToDefaultPath()}
                          disabled={loadingSaves}
                        >
                          {t("save.reset")}
                        </Button>
                      </div>
                    )}
                    <div className="rounded border border-border/40 bg-muted/20 px-2 py-1.5 text-[10px] text-muted-foreground break-all">
                      {activePathLabel}
                    </div>
                    {debugInfo?.autoPicked && !customPath && (
                      <div className="rounded border border-primary/30 bg-primary/5 px-2 py-1.5 text-[10px] space-y-1">
                        <div className="flex items-start gap-1.5">
                          <CheckCircle2 className="w-3 h-3 text-primary shrink-0 mt-0.5" />
                          <span>{t("save.autoDetected")}</span>
                        </div>
                        <DisabledReason reason={!canManageChunks ? t("permissions.noManage") : null}>
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full h-6 text-[10px]"
                            onClick={() =>
                              void persistCurrentPath(debugInfo.autoPicked!)
                            }
                            disabled={savingPath || !canManageChunks}
                          >
                            <Save className="w-3 h-3 me-1" />
                            {savingPath ? t("save.saving") : t("save.saveAsDefault")}
                          </Button>
                        </DisabledReason>
                      </div>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              </CardContent>
            </Card>

            {stats &&
              (() => {
                const folderEntries = Object.entries(stats.folders || {});
                const folderTotal = folderEntries.reduce(
                  (sum, [, info]) => sum + (info.size || 0),
                  0,
                );
                const swatchClasses = [
                  "bg-primary/70",
                  "bg-primary/45",
                  "bg-warning/65",
                  "bg-warning/40",
                  "bg-muted-foreground/40",
                ];
                return (
                  <Card>
                    <CardContent className="px-4 py-3 space-y-2.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                          <Database className="w-3 h-3" /> {t("stats.worldFootprint")}
                        </span>
                        <span className="text-sm font-semibold tabular-nums text-foreground">
                          {stats.totalSizeFormatted}
                        </span>
                      </div>
                      {folderEntries.length > 0 && folderTotal > 0 && (
                        <>
                          <div
                            className="flex h-1.5 w-full overflow-hidden rounded-full border border-border/40 bg-muted/30"
                            aria-hidden="true"
                          >
                            {folderEntries.map(([folder, info], i) => {
                              const pct = (info.size / folderTotal) * 100;
                              if (pct < 0.5) return null;
                              return (
                                <div
                                  key={folder}
                                  className={
                                    swatchClasses[i % swatchClasses.length]
                                  }
                                  style={{ width: `${pct}%` }}
                                  title={t("stats.folderShare", {
                                    folder,
                                    size: info.sizeFormatted,
                                  })}
                                />
                              );
                            })}
                          </div>
                          <div className="space-y-1">
                            {folderEntries.map(([folder, info], i) => (
                              <div
                                key={folder}
                                className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground"
                              >
                                <span className="flex items-center gap-1.5 min-w-0">
                                  <span
                                    className={`shrink-0 w-1.5 h-1.5 rounded-sm ${swatchClasses[i % swatchClasses.length]}`}
                                    aria-hidden="true"
                                  />
                                  <span className="truncate text-foreground/85">
                                    {folder}
                                  </span>
                                </span>
                                <span className="shrink-0 tabular-nums">
                                  {info.fileCount} · {info.sizeFormatted}
                                </span>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </CardContent>
                  </Card>
                );
              })()}

            <Card>
              <CardContent className="px-4 py-3 space-y-3">
                <div className="flex items-center gap-1.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={tool === "select" ? "default" : "outline"}
                        size="icon"
                        onClick={() => setTool("select")}
                        aria-label={t("tools.selectToolAria")}
                      >
                        <Square className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tools.selectToolTooltip")}</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={tool === "pan" ? "default" : "outline"}
                        size="icon"
                        onClick={() => setTool("pan")}
                        aria-label={t("tools.panToolAria")}
                      >
                        <Move className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tools.panToolTooltip")}</TooltipContent>
                  </Tooltip>

                  <Separator orientation="vertical" className="h-6 mx-0.5" />

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={t("tools.zoomInAria")}
                        onClick={() => {
                          const newScale = Math.min(MAX_SCALE, scale * 1.3);
                          const cx = canvasSize.width / 2;
                          const cy = canvasSize.height / 2;
                          const wx = (cx - offset.x) / scale;
                          const wy = (cy - offset.y) / scale;
                          setScale(newScale);
                          setOffset({
                            x: cx - wx * newScale,
                            y: cy - wy * newScale,
                          });
                        }}
                      >
                        <ZoomIn className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tools.zoomInTooltip")}</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={t("tools.zoomOutAria")}
                        onClick={() => {
                          const newScale = Math.max(MIN_SCALE, scale * 0.7);
                          const cx = canvasSize.width / 2;
                          const cy = canvasSize.height / 2;
                          const wx = (cx - offset.x) / scale;
                          const wy = (cy - offset.y) / scale;
                          setScale(newScale);
                          setOffset({
                            x: cx - wx * newScale,
                            y: cy - wy * newScale,
                          });
                        }}
                      >
                        <ZoomOut className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tools.zoomOutTooltip")}</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={fitView}
                        aria-label={t("tools.fitAllAria")}
                      >
                        <Maximize className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("tools.fitAllTooltip")}</TooltipContent>
                  </Tooltip>
                </div>

                <div className="flex items-center justify-between pt-0.5">
                  <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                    {showMap ? (
                      <Image className="w-3.5 h-3.5" />
                    ) : (
                      <ImageOff className="w-3.5 h-3.5" />
                    )}
                    {t("tools.map")}
                  </Label>
                  <Switch checked={showMap} onCheckedChange={setShowMap} />
                </div>

                <div className="flex items-center justify-between pt-0.5">
                  <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Car className="w-3.5 h-3.5" />
                    {t("tools.vehicles")}
                    {chunkVehicles.length > 0 && (
                      <span className="text-[10px] tabular-nums opacity-60">
                        ({chunkVehicles.length})
                      </span>
                    )}
                  </Label>
                  <Switch
                    checked={showVehicles}
                    onCheckedChange={setShowVehicles}
                  />
                </div>

                <div className="flex items-center justify-between pt-0.5">
                  <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Home className="w-3.5 h-3.5" />
                    {t("tools.safehouses")}
                    {chunkSafehouses.length > 0 && (
                      <span className="text-[10px] tabular-nums opacity-60">
                        ({chunkSafehouses.length})
                      </span>
                    )}
                  </Label>
                  <Switch
                    checked={showSafehouses}
                    onCheckedChange={setShowSafehouses}
                  />
                </div>

                <Separator />

                <div className="space-y-2">
                  <div
                    className={`flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 transition-colors ${
                      selectedChunks.size > 0
                        ? "border-destructive/40 bg-destructive/[0.06]"
                        : "border-border/50 bg-muted/20"
                    }`}
                  >
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                      <span
                        className={`inline-block w-1.5 h-1.5 rounded-full ${
                          selectedChunks.size > 0
                            ? "bg-destructive"
                            : "bg-muted-foreground/40"
                        }`}
                        aria-hidden="true"
                      />
                      {t("tools.selection")}
                      <HelpTip label={t("tools.selection")}>
                        {t("tools.selectAllTip")}
                      </HelpTip>
                    </span>
                    <span
                      className={`text-[11px] font-semibold tabular-nums ${selectedChunks.size > 0 ? "text-destructive" : "text-muted-foreground/70"}`}
                    >
                      {selectedChunks.size > 0
                        ? `${selectedChunks.size} · ${formatSize(selectedSize)}`
                        : t("tools.selectionNone")}
                    </span>
                  </div>
                  <div className="flex gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 text-xs flex-1"
                      onClick={selectAll}
                      disabled={chunks.length === 0}
                    >
                      {t("tools.all")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 text-xs flex-1"
                      onClick={clearSelection}
                      disabled={selectedChunks.size === 0}
                    >
                      {t("tools.clear")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 text-xs flex-1"
                      onClick={invertSelection}
                      disabled={chunks.length === 0}
                    >
                      {t("tools.invert")}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {selectedChunks.size > 0 && (
              <DisabledReason reason={!canManageChunks ? t("permissions.noManage") : null} className="w-full">
                <Button
                  variant="destructive"
                  className="w-full h-9 text-sm"
                  disabled={!canManageChunks}
                  onClick={() => {
                    setDeleteVehicles(true);
                    setDeleteDialogOpen(true);
                  }}
                >
                  <Trash2 className="w-4 h-4 me-2" />
                  {t("deleteButton", { count: selectedChunks.size })}
                </Button>
              </DisabledReason>
            )}
          </div>

          <div className="order-1 lg:order-2">
            <Card className="flex flex-col h-[24rem] min-h-[320px] sm:h-[30rem] lg:h-[36rem]">
              <CardContent className="flex-1 p-2 min-h-0">
                {!selectedSave ? (
                  loadingSaves ? (
                    <div className="h-full flex items-center justify-center">
                      <div className="text-center text-muted-foreground">
                        <RefreshCw className="w-6 h-6 mx-auto animate-spin" />
                        <p className="mt-3 text-xs font-medium">
                          {t("save.placeholderLoading")}
                        </p>
                      </div>
                    </div>
                  ) : hasSaves ? (
                    <div className="h-full flex items-center justify-center text-muted-foreground">
                      <div className="text-center max-w-xs">
                        <FileBox className="w-10 h-10 mx-auto mb-3 opacity-40" />
                        <p className="font-medium text-foreground text-sm">
                          {t("canvas.selectSaveTitle")}
                        </p>
                        <p className="text-xs mt-1.5 opacity-70">
                          {t("canvas.selectSaveDesc")}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="h-full overflow-y-auto p-4 sm:p-6">
                      <div className="max-w-xl mx-auto space-y-4">
                        <div className="text-center">
                          <FileBox className="w-10 h-10 mx-auto mb-2 opacity-40" />
                          <p className="font-medium text-foreground text-sm">
                            {t("canvas.noSavesTitle")}
                          </p>
                          <p className="text-xs mt-1 text-muted-foreground">
                            {t("canvas.noSavesDesc")}
                          </p>
                        </div>

                        <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2.5 space-y-1.5">
                          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                            <Info className="w-3 h-3" /> {t("canvas.whatTried")}
                          </div>
                          <div className="text-[11px] space-y-1">
                            <div className="flex gap-2">
                              <span className="text-muted-foreground shrink-0 w-20">
                                {t("canvas.dataFolder")}
                              </span>
                              <span className="font-mono break-all">
                                {debugInfo?.zomboidDataPath ??
                                  t("canvas.dataFolderNotConfigured")}
                              </span>
                            </div>
                            {debugInfo?.savesPath && (
                              <div className="flex gap-2">
                                <span className="text-muted-foreground shrink-0 w-20">
                                  {t("canvas.savesFolder")}
                                </span>
                                <span className="font-mono break-all">
                                  {debugInfo.savesPath}
                                </span>
                                {debugInfo.exists ? (
                                  <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0 mt-0.5" />
                                ) : (
                                  <XCircle className="w-3 h-3 text-destructive shrink-0 mt-0.5" />
                                )}
                              </div>
                            )}
                            {debugInfo?.attempted &&
                              debugInfo.attempted.length > 1 && (
                                <div className="flex gap-2">
                                  <span className="text-muted-foreground shrink-0 w-20">
                                    {t("canvas.alsoChecked")}
                                  </span>
                                  <span className="font-mono break-all opacity-75">
                                    {debugInfo.attempted.slice(1).join(", ")}
                                  </span>
                                </div>
                              )}
                          </div>
                          {(debugInfo?.hint || loadError) && (
                            <p className="text-[11px] text-warning/90 pt-1 flex gap-1.5">
                              <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                              <span>{debugInfo?.hint || loadError}</span>
                            </p>
                          )}
                          {debugInfo?.rejection && (
                            <div className="pt-1 space-y-1">
                              {debugInfo.rejection.tried && (
                                <div className="text-[10px] text-muted-foreground">
                                  {t("canvas.tried")}{" "}
                                  <span className="font-mono break-all">
                                    {debugInfo.rejection.tried}
                                  </span>
                                </div>
                              )}
                              {debugInfo.rejection.reason ===
                                "install-folder" && (
                                <p className="text-[10px] text-destructive/90">
                                  {t("canvas.installFolderHint")}
                                </p>
                              )}
                              {debugInfo.rejection.parentSuggestion && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-[10px]"
                                  onClick={() =>
                                    void applySuggestedPath(
                                      debugInfo.rejection!.parentSuggestion!,
                                    )
                                  }
                                >
                                  <FolderOpen className="w-3 h-3 me-1" />
                                  {t("canvas.tryParent")}{" "}
                                  <span className="font-mono ms-1 truncate max-w-[180px]">
                                    {debugInfo.rejection.parentSuggestion}
                                  </span>
                                </Button>
                              )}
                              {debugInfo.rejection.checks &&
                                debugInfo.rejection.reason ===
                                  "no-zomboid-markers" && (
                                  <details className="text-[10px] text-muted-foreground">
                                    <summary className="cursor-pointer hover:text-foreground/80">
                                      {t("canvas.whyRejected")}
                                    </summary>
                                    <ul className="ps-3 pt-1 space-y-0.5">
                                      {Object.entries(
                                        debugInfo.rejection.checks,
                                      ).map(([k, v]) => (
                                        <li
                                          key={k}
                                          className="flex gap-1.5 items-center"
                                        >
                                          {v ? (
                                            <CheckCircle2 className="w-2.5 h-2.5 text-emerald-500" />
                                          ) : (
                                            <XCircle className="w-2.5 h-2.5 text-destructive/60" />
                                          )}
                                          <span className="font-mono">{k}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  </details>
                                )}
                            </div>
                          )}
                        </div>

                        {debugInfo?.suggestedPaths &&
                          debugInfo.suggestedPaths.length > 0 && (
                            <div className="rounded-md border border-border/60 bg-muted/10 px-3 py-2.5 space-y-2">
                              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                <FolderOpen className="w-3 h-3" /> {t("canvas.tryCommonLocation")}
                              </div>
                              <ul className="space-y-1">
                                {debugInfo.suggestedPaths.map((s) => (
                                  <li
                                    key={s.path}
                                    className="flex items-center gap-2"
                                  >
                                    <DisabledReason
                                      reason={!s.exists ? t("canvas.titleFolderMissing") : null}
                                      className="flex-1"
                                    >
                                      <button
                                        type="button"
                                        onClick={() =>
                                          void applySuggestedPath(s.path)
                                        }
                                        disabled={!s.exists || loadingSaves}
                                        className="flex-1 text-start text-[11px] font-mono px-2 py-1 rounded border border-border/40 bg-background hover:bg-accent/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors break-all"
                                        // eslint-disable-next-line local/no-dead-disabled-title -- split 2026-08-27 (rule's own shape-2 guidance): the disabled-reason branch (folder missing) now lives in the DisabledReason wrapper above; this title carries only the enabled-state status hint and is correctly absent, not dead, when the wrapper's reason covers the disable.
                                        title={
                                          s.exists
                                            ? s.hasSaves
                                              ? t("canvas.titleHasSaves")
                                              : t("canvas.titleFolderExists")
                                            : undefined
                                        }
                                      >
                                        {s.path}
                                      </button>
                                    </DisabledReason>
                                    {s.hasSaves ? (
                                      <Badge
                                        variant="secondary"
                                        className="text-[9px] h-4 px-1.5 shrink-0"
                                      >
                                        {t("canvas.badgeHasSaves")}
                                      </Badge>
                                    ) : s.exists ? (
                                      <Badge
                                        variant="outline"
                                        className="text-[9px] h-4 px-1.5 shrink-0 opacity-70"
                                      >
                                        {t("canvas.badgeExists")}
                                      </Badge>
                                    ) : (
                                      <span className="text-[9px] text-muted-foreground/60 shrink-0">
                                        {t("canvas.badgeMissing")}
                                      </span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                        <div className="rounded-md border border-border/60 bg-muted/10 px-3 py-2.5 space-y-1.5">
                          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                            <HelpCircle className="w-3 h-3" /> {t("canvas.howToFind")}
                          </div>
                          <ul className="text-[11px] text-muted-foreground space-y-1 list-disc list-inside">
                            <li>
                              {t("canvas.windowsPath")}{" "}
                              <span className="font-mono text-foreground/80">
                                C:\Users\&lt;you&gt;\Zomboid
                              </span>
                            </li>
                            <li>
                              {t("canvas.linuxPath")}{" "}
                              <span className="font-mono text-foreground/80">
                                ~/Zomboid
                              </span>{" "}
                              {t("canvas.linuxHint")}
                            </li>
                            <li>
                              <Trans
                                i18nKey="canvas.mustContain"
                                t={t}
                                components={{
                                  1: <span className="font-mono text-foreground/80" />,
                                }}
                              />
                            </li>
                            <li>
                              <Trans
                                i18nKey="canvas.pointDirect"
                                t={t}
                                components={{
                                  1: <span className="font-mono text-foreground/80" />,
                                }}
                              />
                            </li>
                          </ul>
                        </div>

                        <div className="flex gap-2 justify-center pt-1">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 text-xs"
                            onClick={() => {
                              setShowCustomPath(true);
                            }}
                          >
                            <FolderOpen className="w-3.5 h-3.5 me-1.5" />
                            {t("canvas.setCustomPath")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 text-xs"
                            onClick={() => void fetchSaves()}
                            disabled={loadingSaves}
                          >
                            <RefreshCw
                              className={`w-3.5 h-3.5 me-1.5 ${loadingSaves ? "animate-spin" : ""}`}
                            />
                            {t("canvas.tryAgain")}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )
                ) : loading ? (
                  <div className="h-full flex items-center justify-center">
                    <div className="text-center text-muted-foreground w-56 max-w-[80%]">
                      <RefreshCw className="w-6 h-6 mx-auto animate-spin" />
                      {scanProgress && scanProgress.total > 0 ? (
                        <>
                          <p className="mt-3 text-xs font-medium text-foreground tabular-nums">
                            {t("canvas.scanningPercent", {
                              percent: Math.floor(
                                (scanProgress.scanned / scanProgress.total) * 100,
                              ),
                            })}
                          </p>
                          <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full bg-primary transition-[width] duration-200 ease-out"
                              style={{
                                width: `${Math.min(100, (scanProgress.scanned / scanProgress.total) * 100)}%`,
                              }}
                            />
                          </div>
                          <p className="mt-1.5 text-[11px] opacity-70 tabular-nums">
                            {t("canvas.scanProgressDetail", {
                              chunks: scanProgress.chunks.toLocaleString(i18n.language),
                              scanned: scanProgress.scanned.toLocaleString(i18n.language),
                              total: scanProgress.total.toLocaleString(i18n.language),
                            })}
                          </p>
                        </>
                      ) : (
                        <p className="mt-2 text-xs">
                          {scanProgress
                            ? t("canvas.scanningChunks", {
                                count: scanProgress.chunks.toLocaleString(i18n.language),
                              })
                            : t("canvas.loadingChunks")}
                        </p>
                      )}
                    </div>
                  </div>
                ) : chunks.length === 0 ? (
                  <div className="h-full flex items-center justify-center">
                    <EmptyState
                      type="noFile"
                      title={t("canvas.noChunksTitle")}
                      description={t("canvas.noChunksDesc")}
                      compact
                    />
                  </div>
                ) : (
                  <div
                    ref={containerRef}
                    className="h-full w-full overflow-hidden"
                  >
                    {canvasSize.width > 0 && (
                      <canvas
                        ref={canvasRef}
                        width={canvasSize.width}
                        height={canvasSize.height}
                        role="img"
                        aria-label={t("canvas.ariaLabel")}
                        style={{
                          width: canvasSize.width,
                          height: canvasSize.height,
                          borderRadius: "0.375rem",
                          border: "1px solid hsl(var(--border))",
                          cursor: tool === "pan" ? "grab" : "crosshair",
                        }}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        onMouseLeave={handleMouseLeave}
                        onTouchStart={handleTouchStart}
                        onTouchMove={handleTouchMove}
                        onTouchEnd={handleTouchEnd}
                        onWheel={handleWheel}
                        onContextMenu={handleContextMenu}
                      />
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
        )}

        <Collapsible open={showHelp} onOpenChange={setShowHelp}>
          <CollapsibleTrigger asChild>
            <button className="flex items-center gap-2 text-xs text-muted-foreground/70 hover:text-muted-foreground transition-colors w-full">
              <Info className="w-3.5 h-3.5" />
              <span>{showHelp ? t("help.hide") : t("help.show")}</span>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-3 rounded-lg border border-border/40 bg-muted/20 px-4 py-3 text-xs text-muted-foreground space-y-1.5">
              <p>
                <strong className="text-foreground/80">{t("help.selectTitle")}</strong> —{" "}
                {t("help.selectDesc")}
              </p>
              <p>
                <strong className="text-foreground/80">{t("help.navigateTitle")}</strong> —{" "}
                {t("help.navigateDesc")}
              </p>
              <p>
                <strong className="text-foreground/80">{t("help.deleteTitle")}</strong> —{" "}
                {t("help.deleteDesc")}
              </p>
              <p>
                <strong className="text-foreground/80">{t("help.shortcutsTitle")}</strong> —{" "}
                {t("help.shortcutsDesc")}
              </p>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="w-5 h-5" />
                {t("deleteDialog.title", { count: selectedChunks.size })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("deleteDialog.description", {
                  count: selectedChunks.size,
                  size: formatSize(selectedSize),
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 rounded-lg bg-muted">
                <div>
                  <Label>{t("deleteDialog.backupLabel")}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t("deleteDialog.backupDesc")}
                  </p>
                </div>
                <Switch
                  checked={createBackup}
                  onCheckedChange={setCreateBackup}
                />
              </div>

              {!createBackup && (
                <div className="rounded-lg border border-destructive/25 bg-destructive/8 p-3 text-sm">
                  <p className="font-medium text-destructive">
                    {t("deleteDialog.noBackupTitle")}
                  </p>
                  <p className="text-muted-foreground">
                    {t("deleteDialog.noBackupDesc")}
                  </p>
                </div>
              )}

              {(() => {
                const selChunkKeys = selectedChunks;
                const vehiclesInArea = chunkVehicles.filter((v) =>
                  selChunkKeys.has(`${v.x}_${v.y}`),
                );
                const loadedCount = vehiclesInArea.length;
                return (
                  <div className="flex items-center justify-between p-3 rounded-lg bg-muted">
                    <div className="min-w-0 pe-3">
                      <Label className="flex items-center gap-1.5">
                        <Car className="w-3.5 h-3.5" />
                        {t("deleteDialog.removeVehiclesLabel")}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {loadedCount > 0
                          ? t("deleteDialog.removeVehiclesLoaded", {
                              count: loadedCount,
                            })
                          : t("deleteDialog.removeVehiclesUnloaded")}
                        {t("deleteDialog.removeVehiclesDetail")}
                      </p>
                    </div>
                    <Switch
                      checked={deleteVehicles}
                      onCheckedChange={setDeleteVehicles}
                    />
                  </div>
                );
              })()}

              {(() => {
                const selChunkKeys = selectedChunks;
                const overlapping = chunkSafehouses.filter((sh) => {
                  for (let cx = sh.x; cx < sh.x + sh.w; cx++) {
                    for (let cy = sh.y; cy < sh.y + sh.h; cy++) {
                      if (selChunkKeys.has(`${cx}_${cy}`)) return true;
                    }
                  }
                  return false;
                });
                return overlapping.length > 0 ? (
                  <div className="rounded-lg border border-warning/25 bg-warning/8 p-3 text-sm">
                    <p className="font-medium text-warning flex items-center gap-1.5">
                      <Home className="w-3.5 h-3.5" />
                      {t("deleteDialog.safehouseOverlap", {
                        count: overlapping.length,
                      })}
                    </p>
                    <p className="text-muted-foreground text-xs mt-1 truncate">
                      {overlapping
                        .slice(0, 5)
                        .map((sh) => sh.owner || sh.title || t("deleteDialog.safehouseUnknown"))
                        .join(", ")}
                      {overlapping.length > 5
                        ? t("deleteDialog.safehouseOverlapMore", {
                            count: overlapping.length - 5,
                          })
                        : ""}{" "}
                      {t("deleteDialog.safehouseOverlapSuffix")}
                    </p>
                  </div>
                ) : null;
              })()}
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>
                {t("deleteDialog.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  void handleDelete();
                }}
                disabled={deleting}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {deleting ? (
                  <>
                    <RefreshCw className="w-4 h-4 me-2 animate-spin" />
                    {t("deleteDialog.deleting")}
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4 me-2" />
                    {t("deleteDialog.confirm")}
                  </>
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={serverRunningDialog.open}
          onOpenChange={(open) => {
            if (!open && serverRunningDialog.resolve) {
              serverRunningDialog.resolve(false);
              setServerRunningDialog({ open: false, matched: [] });
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-warning" />
                {t("serverRunningDialog.title")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("serverRunningDialog.description")}
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="space-y-3 py-2">
              {serverRunningDialog.matched.length > 0 ? (
                <div className="rounded-lg border bg-muted/40 p-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2">
                    {t("serverRunningDialog.matchedProcess", {
                      count: serverRunningDialog.matched.length,
                    })}
                  </p>
                  <ul className="space-y-1.5 text-xs font-mono break-all">
                    {serverRunningDialog.matched.map((m, i) => (
                      <li key={i} className="flex gap-2">
                        {m.pid && (
                          <span className="text-muted-foreground shrink-0">
                            {t("serverRunningDialog.pidLabel", { pid: m.pid })}
                          </span>
                        )}
                        <span className="text-foreground/85">{m.cmd}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t("serverRunningDialog.noMatchInfo")}
                </p>
              )}
              <div className="rounded-lg border border-warning/25 bg-warning/8 p-3 text-xs">
                <p className="font-medium text-warning mb-1">
                  {t("serverRunningDialog.overrideWarningTitle")}
                </p>
                <p className="text-muted-foreground">
                  {t("serverRunningDialog.overrideWarningDesc")}
                </p>
              </div>
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel
                onClick={() => {
                  serverRunningDialog.resolve?.(false);
                  setServerRunningDialog({ open: false, matched: [] });
                }}
              >
                {t("serverRunningDialog.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  serverRunningDialog.resolve?.(true);
                  setServerRunningDialog({ open: false, matched: [] });
                }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                <Trash2 className="w-4 h-4 me-2" />
                {t("serverRunningDialog.forceDelete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}
