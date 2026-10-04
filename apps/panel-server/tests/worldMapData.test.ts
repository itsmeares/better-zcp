import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import archiver from "archiver";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-world-map-"));

vi.mock("../services/sandboxPersistence.ts", () => ({
  getCurrentServerContext: async () => ({
    activeServer: { installPath: root },
    serverConfigPath: path.join(root, "Server"),
    serverName: "test",
  }),
}));

const {
  getWorldMapData,
  parseAnnotations,
  parseLotHeader,
  parseStreetsXml,
  parseWorldMapXml,
  readPyramidTile,
  searchWorldMap,
} = await import("../services/worldMapData.ts");
const { worldMapManifest } = await import("../routes/worldMap.ts");

type TestRoom = { name: string; z: number; rects: Array<[number, number, number, number]> };

/** A B42 lotheader with one tile name, the given rooms (each with one object), one building and a density grid. */
function lotHeader(rooms: TestRoom[], density: Record<number, number> = {}): Buffer {
  const parts: Buffer[] = [];
  const int = (...values: number[]) => {
    const buffer = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => buffer.writeInt32LE(value, index * 4));
    parts.push(buffer);
  };
  const line = (value: string) => parts.push(Buffer.from(`${value}\n`, "latin1"));
  parts.push(Buffer.from("LOTH"));
  int(1, 1);
  line("floors_exterior_street_01_0");
  int(8, 8, -1, 2, rooms.length);
  for (const room of rooms) {
    line(room.name);
    int(room.z, room.rects.length, ...room.rects.flat(), 1, 7, 1, 1);
  }
  int(1, rooms.length, ...rooms.map((_, index) => index));
  const grid = Buffer.alloc(1024);
  for (const [index, value] of Object.entries(density)) grid[Number(index)] = value;
  parts.push(grid);
  return Buffer.concat(parts);
}

function worldMapXml(cells: Array<{ x: number; y: number; props: Record<string, string> }>): string {
  return `<?xml version="1.0"?>\n<world version="1.0">\n${cells.map((cell) => ` <cell x="${cell.x}" y="${cell.y}">
  <feature>
   <geometry type="Polygon">
    <coordinates>
     <point x="10" y="20"/>
     <point x="30" y="20"/>
     <point x="30" y="40"/>
    </coordinates>
   </geometry>
   <properties>
${Object.entries(cell.props).map(([name, value]) => `    <property name="${name}" value="${value}"/>`).join("\n")}
   </properties>
  </feature>
 </cell>`).join("\n")}\n</world>\n`;
}

async function writeZip(file: string, entries: Record<string, string | Buffer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(file);
    const archive = archiver("zip");
    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(output);
    for (const [name, content] of Object.entries(entries)) archive.append(content, { name });
    void archive.finalize();
  });
}

const vanilla = path.join(root, "media", "maps", "Base");
const mod = path.join(root, "steamapps", "workshop", "content", "108600", "123", "mods", "ModMap", "42", "media", "maps", "ModMap");

beforeAll(async () => {
  fs.mkdirSync(vanilla, { recursive: true });
  fs.mkdirSync(mod, { recursive: true });
  fs.mkdirSync(path.join(root, "Server"));
  fs.mkdirSync(path.join(root, "media", "lua", "shared", "Translate", "EN"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "Server", "test.ini"),
    "Map=ModMap;Base;../Escape;Missing\nWorkshopItems=123\n",
  );
  fs.writeFileSync(
    path.join(root, "media", "lua", "shared", "Translate", "EN", "MapLabel.json"),
    JSON.stringify({ MapLabel_Town: "BASE<br>TOWN" }),
  );

  fs.writeFileSync(path.join(vanilla, "0_0.lotheader"), lotHeader([{ name: "baseroom", z: 0, rects: [[1, 1, 4, 4]] }]));
  fs.writeFileSync(
    path.join(vanilla, "1_0.lotheader"),
    lotHeader(
      [
        { name: "vault", z: -1, rects: [[10, 20, 5, 5]] },
        { name: "office", z: 2, rects: [[10, 20, 5, 5], [15, 20, 2, 2]] },
      ],
      // chunks (2,5) and (3,5) share a value and merge; (2,6) differs.
      { [2 * 32 + 5]: 7, [3 * 32 + 5]: 7, [2 * 32 + 6]: 4 },
    ),
  );
  fs.writeFileSync(
    path.join(vanilla, "worldmap.xml"),
    worldMapXml([
      { x: 0, y: 0, props: { building: "Residential", RoomTone: "HouseSmall" } },
      { x: 1, y: 0, props: { building: "CommunityServices", RoomTone: "Police" } },
    ]),
  );
  fs.writeFileSync(
    path.join(vanilla, "streets.xml"),
    `<streets version="1">\n<street name="Bank Road" width="8">\n<points>\n<point x="100.0" y="50.0"/>\n<point x="200.0" y="50.0"/>\n</points>\n</street>\n</streets>\n`,
  );
  fs.writeFileSync(
    path.join(vanilla, "worldmap-annotations.lua"),
    `return function(mapUI)\n  symbol = symbolsAPI:addUntranslatedText("MapLabel_Town", "text-town", 300, 400)\n  symbol:setScale(2.0)\n  symbol:setRotation(15.5)\n  symbol = symbolsAPI:addUntranslatedText("Otter Pond", "text-water", 50, 60)\nend\n`,
  );
  await writeZip(path.join(vanilla, "pyramid.zip"), {
    "pyramid.txt": "VERSION=1\nbounds=0 0 512 512\nimageSize=512 512\n",
    "0/tile1x0.png": Buffer.from("level0"),
    "1/tile0x0.png": Buffer.from("level1"),
  });

  fs.writeFileSync(path.join(mod, "0_0.lotheader"), lotHeader([{ name: "modroom", z: 0, rects: [[2, 2, 3, 3]] }]));
  fs.writeFileSync(path.join(mod, "worldmap.xml"), worldMapXml([{ x: 0, y: 0, props: { building: "Industrial", RoomTone: "Factory" } }]));
  await writeZip(path.join(mod, "pyramid.zip"), {
    "pyramid.txt": "VERSION=1\nbounds=0 0 512 512\nimageSize=512 512\n",
  });
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("world map file parsers", () => {
  it("reads rooms with floors and the column-major density grid from a lotheader", () => {
    const header = parseLotHeader(lotHeader([
      { name: "vault", z: -1, rects: [[10, 20, 5, 5]] },
      { name: "bedroom", z: 1, rects: [[0, 0, 2, 2], [2, 0, 1, 1]] },
    ], { 70: 3 }), 2, 3);
    expect(header.rooms).toEqual([
      { name: "vault", z: -1, rects: [[522, 788, 5, 5]] },
      { name: "bedroom", z: 1, rects: [[512, 768, 2, 2], [514, 768, 1, 1]] },
    ]);
    expect(header.density[70]).toBe(3);
  });

  it("rejects a lotheader whose contents do not add up", () => {
    const valid = lotHeader([{ name: "kitchen", z: 0, rects: [[0, 0, 1, 1]] }]);
    expect(() => parseLotHeader(valid.subarray(0, valid.length - 1), 0, 0)).toThrow();
    expect(() => parseLotHeader(Buffer.from("NOPE"), 0, 0)).toThrow("not a lotheader");
  });

  it("places worldmap.xml points by their 300-square cell", () => {
    const cells = parseWorldMapXml(worldMapXml([{ x: 2, y: 1, props: { water: "river" } }]));
    expect(cells.get("2,1")).toEqual([
      { kind: "water", value: "river", type: "Polygon", rings: [[[610, 320], [630, 320], [630, 340]]] },
    ]);
  });

  it("reads street names and annotation labels without running Lua", () => {
    expect(parseStreetsXml(`<street name="Oak &amp; Elm" width="6"><points><point x="1" y="2"/><point x="3" y="4"/></points></street>`))
      .toEqual([{ name: "Oak & Elm", width: 6, points: [[1, 2], [3, 4]] }]);
    expect(parseAnnotations(`addUntranslatedText("MapLabel_SaltRiver", "text-water", 5, 6)\nsymbol:setRotation(90)`, {}))
      .toEqual([{ text: "Salt River", layer: "text-water", x: 5, y: 6, rotation: 90, scale: 1 }]);
  });
});

describe("world map data for the active server", () => {
  it("resolves Map= folders in priority order and warns about the rest", async () => {
    const data = await getWorldMapData();
    expect(data.folders.map((folder) => [folder.name, folder.source])).toEqual([
      ["ModMap", "workshop"],
      ["Base", "vanilla"],
    ]);
    expect(data.warnings.join(" ")).toContain("../Escape");
    expect(data.warnings.join(" ")).toContain("Missing");
    expect(worldMapManifest(data)).toMatchObject({
      key: data.key,
      folders: [{ id: 0, name: "ModMap", image: null }, { id: 1, name: "Base", image: { minZoom: 6, maxZoom: 7 } }],
      bounds: [0, 0, 512, 256],
      floors: { min: -1, max: 2 },
    });
  });

  it("lets the higher-priority folder own a cell, like the game does", async () => {
    const data = await getWorldMapData();
    const groundRooms = JSON.parse(zlib.gunzipSync(data.rooms.get(0)!).toString());
    expect(groundRooms).toEqual([["modroom", [[2, 2, 3, 3]]]]);
    const features = JSON.parse(zlib.gunzipSync(data.features).toString()).features;
    const buildings = features.filter((feature: any) => feature.properties.kind === "building").map((feature: any) => feature.properties.roomTone);
    expect(buildings).toEqual(["Factory", "Police"]);
    expect(features.find((feature: any) => feature.properties.kind === "label").properties).toMatchObject({ name: "BASE\nTOWN", rotation: 15.5, scale: 2 });
  });

  it("serves density as runs of equal 8-square chunks in world chunk coordinates", async () => {
    const data = await getWorldMapData();
    expect(JSON.parse(zlib.gunzipSync(data.density).toString())).toEqual({ chunk: 8, runs: [32 + 2, 5, 2, 7, 32 + 2, 6, 1, 4] });
  });

  it("reads pyramid tiles by map zoom and returns null outside the image", async () => {
    const pyramid = (await getWorldMapData()).folders[1].pyramid!;
    expect((await readPyramidTile(pyramid, 7, 1, 0))?.toString()).toBe("level0");
    expect((await readPyramidTile(pyramid, 6, 0, 0))?.toString()).toBe("level1");
    expect(await readPyramidTile(pyramid, 7, 5, 5)).toBeNull();
    expect(await readPyramidTile(pyramid, 2, 0, 0)).toBeNull();
  });

  it("rejects a pyramid with valid metadata but no level directories", async () => {
    const data = await getWorldMapData();
    expect(data.folders[0].pyramid).toBeNull();
    expect(data.warnings).toContain(
      'The map image for "ModMap" uses a layout the panel cannot show yet; its outlines are still drawn.',
    );
  });

  it("searches towns, streets, building types and rooms on every floor", async () => {
    const data = await getWorldMapData();
    expect(searchWorldMap(data, "vault", { x: 0, y: 0 })).toEqual([
      { kind: "room", label: "vault", area: "Base Town", x: 268.5, y: 22.5, z: -1 },
    ]);
    expect(searchWorldMap(data, "police", { x: 0, y: 0 })[0]).toMatchObject({ kind: "building", label: "Police", area: "Base Town" });
    expect(searchWorldMap(data, "bank", { x: 0, y: 0 })[0]).toMatchObject({ kind: "street", label: "Bank Road" });
    expect(searchWorldMap(data, "base town", { x: 0, y: 0 })[0]).toMatchObject({ kind: "town", label: "Base Town" });
    expect(searchWorldMap(data, "otter", { x: 0, y: 0 })[0]).toMatchObject({ kind: "place", label: "Otter Pond", area: "Base Town" });
  });
});
