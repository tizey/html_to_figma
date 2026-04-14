import type {
  ImportMode,
  ImportRequest,
  ImportSnapshot,
  ScreenshotSlice,
  SnapshotImageNode,
  SnapshotNode,
  SnapshotTextNode,
  ViewportPreset
} from "../shared/contracts.js";

declare const __UI_HTML__: string;

const DEFAULT_SERVICE_URL = "http://localhost:3210";
const PLUGIN_WIDTH = 420;
const PLUGIN_HEIGHT = 640;
type PluginToUiMessage =
  | { type: "init"; payload: { serviceUrl: string } }
  | {
      type: "status";
      payload: { kind: "info" | "success" | "error"; message: string };
    }
  | { type: "warnings"; payload: { warnings: string[] } };

type UiToPluginMessage =
  | { type: "ui-ready" }
  | {
      type: "submit-import";
      payload: {
        serviceUrl: string;
        url: string;
        mode: ImportMode;
        preset: ViewportPreset;
      };
    }
  | { type: "close-plugin" };

const fontLoadCache = new Map<string, Promise<FontName>>();
let availableFontsPromise: Promise<Font[]> | null = null;

figma.showUI(__UI_HTML__, {
  width: PLUGIN_WIDTH,
  height: PLUGIN_HEIGHT,
  themeColors: true
});

figma.ui.onmessage = async (message: UiToPluginMessage) => {
  if (message.type === "ui-ready") {
    postToUi({ type: "init", payload: { serviceUrl: DEFAULT_SERVICE_URL } });
    return;
  }

  if (message.type === "close-plugin") {
    figma.closePlugin();
    return;
  }

  if (message.type === "submit-import") {
    try {
      const serviceUrl = normalizeServiceUrl(message.payload.serviceUrl);
      const sourceUrl = normalizeHttpUrl(message.payload.url);

      postToUi({
        type: "status",
        payload: {
          kind: "info",
          message:
            message.payload.mode === "screenshot"
              ? "Capturing a full-page screenshot..."
              : "Capturing the website structure..."
        }
      });

      const snapshot = await requestSnapshot(serviceUrl, {
        url: sourceUrl,
        mode: message.payload.mode,
        preset: message.payload.preset
      });

      postToUi({
        type: "status",
        payload: {
          kind: "info",
          message:
            snapshot.mode === "screenshot"
              ? "Placing the long screenshot in Figma..."
              : "Building editable layers in Figma..."
        }
      });

      const { frame, warnings } = await buildImportFrame(snapshot, serviceUrl);

      figma.currentPage.selection = [frame];
      figma.viewport.scrollAndZoomIntoView([frame]);
      figma.notify(`Imported ${frame.name}`);

      postToUi({
        type: "status",
        payload: {
          kind: "success",
          message:
            snapshot.mode === "screenshot"
              ? `Imported ${frame.name} as a full-page screenshot.`
              : `Imported ${frame.name} with ${snapshot.nodes.length} editable layers.`
        }
      });

      const combinedWarnings = snapshot.warnings.concat(warnings);

      if (combinedWarnings.length > 0) {
        postToUi({ type: "warnings", payload: { warnings: combinedWarnings } });
      }
    } catch (error) {
      const messageText = describeUnknownError(error);

      figma.notify(messageText, { error: true });
      postToUi({
        type: "status",
        payload: { kind: "error", message: messageText }
      });
    }
  }
};

function postToUi(message: PluginToUiMessage): void {
  figma.ui.postMessage(message);
}

function normalizeServiceUrl(rawValue: string): string {
  const normalized = rawValue.trim();

  if (!isHttpUrl(normalized)) {
    throw new Error("Capture service URL must start with http:// or https://");
  }

  return normalized.replace(/\/+$/, "");
}

function normalizeHttpUrl(rawValue: string): string {
  const normalized = rawValue.trim();

  if (!isHttpUrl(normalized)) {
    throw new Error("Website URL must start with http:// or https://");
  }

  return normalized;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value);
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  try {
    const serialized = JSON.stringify(error);

    if (serialized && serialized !== "{}") {
      return serialized;
    }
  } catch {
    // Ignore serialization issues and fall back to a generic message.
  }

  return "Unknown import error";
}

async function requestSnapshot(
  serviceUrl: string,
  payload: ImportRequest
): Promise<ImportSnapshot> {
  const response = await fetch(`${serviceUrl}/api/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Capture service returned ${response.status}: ${errorText || "Import failed."}`
    );
  }

  return (await response.json()) as ImportSnapshot;
}

async function buildImportFrame(
  snapshot: ImportSnapshot,
  serviceUrl: string
) : Promise<{ frame: FrameNode; warnings: string[] }> {
  if (snapshot.mode === "screenshot") {
    return createScreenshotFrame(snapshot);
  }

  const frame = figma.createFrame();
  const warnings: string[] = [];
  frame.name = `${snapshot.title} / ${labelForPreset(snapshot.preset)}`;
  frame.resizeWithoutConstraints(
    Math.max(snapshot.viewportWidth, 1),
    Math.max(snapshot.pageHeight, 1)
  );
  frame.layoutMode = "NONE";
  frame.clipsContent = false;

  const frameFill = snapshot.backgroundColor
    ? toSolidPaint(snapshot.backgroundColor)
    : toSolidPaint("#FFFFFF");
  frame.fills = frameFill ? [frameFill] : [];

  for (const node of snapshot.nodes) {
    try {
      const child = await createNodeFromSnapshot(node);

      if (child) {
        frame.appendChild(child);
      }
    } catch (error) {
      warnings.push(
        `Skipped ${node.kind} layer "${node.name}": ${describeUnknownError(error)}`
      );
    }
  }

  return { frame, warnings };
}

async function createScreenshotFrame(
  snapshot: ImportSnapshot
): Promise<{ frame: FrameNode; warnings: string[] }> {
  const screenshotSlices = normalizeScreenshotSlices(snapshot);

  if (screenshotSlices.length === 0) {
    throw new Error("Screenshot data is missing from the capture service response.");
  }

  const frame = figma.createFrame();
  frame.name = `${snapshot.title} / ${labelForPreset(snapshot.preset)} / Screenshot`;
  frame.resizeWithoutConstraints(
    Math.max(snapshot.viewportWidth, 1),
    Math.max(snapshot.pageHeight, 1)
  );
  frame.layoutMode = "NONE";
  frame.clipsContent = false;

  const frameFill = snapshot.backgroundColor
    ? toSolidPaint(snapshot.backgroundColor)
    : toSolidPaint("#FFFFFF");
  frame.fills = frameFill ? [frameFill] : [];

  for (const [index, slice] of screenshotSlices.entries()) {
    const screenshot = figma.createRectangle();
    screenshot.name =
      screenshotSlices.length === 1
        ? "Page Screenshot"
        : `Page Screenshot Slice ${index + 1}`;
    screenshot.x = 0;
    screenshot.y = slice.y;
    screenshot.resizeWithoutConstraints(
      Math.max(snapshot.viewportWidth, 1),
      Math.max(slice.height, 1)
    );
    screenshot.fills = [await createImageFillFromUrl(slice.assetUrl)];
    frame.appendChild(screenshot);
  }

  return {
    frame,
    warnings: [
      screenshotSlices.length > 1
        ? `Screenshot mode preserved the page by stitching together ${screenshotSlices.length} image slices. The result is still not editable text/layout layers.`
        : "Screenshot mode preserves the page visually, but the result is a single image rather than editable text and layout layers."
    ]
  };
}

function normalizeScreenshotSlices(snapshot: ImportSnapshot): ScreenshotSlice[] {
  if (snapshot.screenshotSlices && snapshot.screenshotSlices.length > 0) {
    return [...snapshot.screenshotSlices].sort((left, right) => left.y - right.y);
  }

  if (snapshot.screenshotUrl) {
    return [
      {
        assetUrl: snapshot.screenshotUrl,
        y: 0,
        height: snapshot.pageHeight
      }
    ];
  }

  return [];
}

async function createImageFillFromUrl(assetUrl: string): Promise<ImagePaint> {
  const response = await fetch(assetUrl);

  if (!response.ok) {
    throw new Error(`Screenshot fetch failed with ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const image = figma.createImage(bytes);

  return {
    type: "IMAGE",
    imageHash: image.hash,
    scaleMode: "FILL"
  };
}

function labelForPreset(preset: ViewportPreset): string {
  return preset === "mobile" ? "390px Mobile" : "1440px Desktop";
}

async function createNodeFromSnapshot(
  node: SnapshotNode
): Promise<SceneNode | null> {
  if (node.width < 1 || node.height < 1) {
    return null;
  }

  if (node.kind === "shape") {
    return createShapeNode(node);
  }

  if (node.kind === "text") {
    return createTextLayer(node);
  }

  if (node.kind === "image") {
    return createImageNode(node);
  }

  return null;
}

function createShapeNode(
  node: Extract<SnapshotNode, { kind: "shape" }>
): RectangleNode {
  const rectangle = figma.createRectangle();
  rectangle.name = node.name;
  rectangle.x = node.x;
  rectangle.y = node.y;
  rectangle.resizeWithoutConstraints(node.width, node.height);
  rectangle.opacity = clamp(node.opacity, 0, 1);
  rectangle.cornerRadius = Math.max(node.borderRadius, 0);

  const fill = node.fillColor ? toSolidPaint(node.fillColor) : null;
  rectangle.fills = fill ? [fill] : [];

  const stroke = node.borderColor ? toSolidPaint(node.borderColor) : null;
  rectangle.strokes = stroke ? [stroke] : [];
  rectangle.strokeWeight = Math.max(node.borderWidth, 0);

  return rectangle;
}

async function createTextLayer(node: SnapshotTextNode): Promise<TextNode> {
  const text = figma.createText();
  const fontName = await resolveFontName(
    node.style.fontFamily,
    node.style.fontWeight,
    node.style.fontStyle
  );

  await figma.loadFontAsync(fontName);

  text.name = node.name;
  text.fontName = fontName;
  text.fontSize = clamp(node.style.fontSize, 1, 400);
  text.characters = applyTextTransform(node.text, node.style.textTransform);
  text.lineHeight = {
    unit: "PIXELS",
    value: clamp(node.style.lineHeight, text.fontSize as number, 800)
  };
  text.letterSpacing = {
    unit: "PIXELS",
    value: clamp(node.style.letterSpacing, -50, 200)
  };
  text.textAlignHorizontal = mapHorizontalAlign(node.style.textAlign);
  text.textCase = mapTextCase(node.style.textTransform);

  const fill = toSolidPaint(node.style.color);
  text.fills = fill ? [fill] : [];
  text.opacity = clamp(node.opacity, 0, 1);
  text.x = node.x;
  text.y = node.y;
  const isLikelySingleLine = node.height <= node.style.lineHeight * 1.35;

  if (isLikelySingleLine) {
    text.textAutoResize = "WIDTH_AND_HEIGHT";
  } else {
    text.resize(
      Math.max(node.width, 1),
      Math.max(node.height, Math.max(node.style.fontSize + 4, 12))
    );
    text.textAutoResize = "HEIGHT";
  }

  return text;
}

async function createImageNode(node: SnapshotImageNode): Promise<RectangleNode> {
  const rectangle = figma.createRectangle();
  rectangle.name = node.name;
  rectangle.x = node.x;
  rectangle.y = node.y;
  rectangle.resizeWithoutConstraints(node.width, node.height);
  rectangle.opacity = clamp(node.opacity, 0, 1);
  rectangle.cornerRadius = Math.max(node.borderRadius, 0);

  const fallbackFill = node.backgroundColor
    ? toSolidPaint(node.backgroundColor)
    : toSolidPaint("#F1F5F9");
  rectangle.fills = fallbackFill ? [fallbackFill] : [];

  try {
    const response = await fetch(node.assetUrl);

    if (!response.ok) {
      throw new Error(`Image fetch failed with ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const image = figma.createImage(bytes);

    rectangle.fills = [
      {
        type: "IMAGE",
        imageHash: image.hash,
        scaleMode: node.objectFit === "contain" ? "FIT" : "FILL"
      }
    ];
  } catch (error) {
    console.warn("Failed to import image asset", node.assetUrl, error);
  }

  return rectangle;
}

function applyTextTransform(
  text: string,
  transform: SnapshotTextNode["style"]["textTransform"]
): string {
  if (transform === "uppercase") {
    return text.toUpperCase();
  }

  if (transform === "lowercase") {
    return text.toLowerCase();
  }

  if (transform === "capitalize") {
    return text.replace(/\b\w/g, (character) => character.toUpperCase());
  }

  return text;
}

function mapHorizontalAlign(
  align: SnapshotTextNode["style"]["textAlign"]
): "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED" {
  if (align === "center") {
    return "CENTER";
  }

  if (align === "right") {
    return "RIGHT";
  }

  if (align === "justify") {
    return "JUSTIFIED";
  }

  return "LEFT";
}

function mapTextCase(
  transform: SnapshotTextNode["style"]["textTransform"]
): TextCase {
  if (transform === "uppercase") {
    return "UPPER";
  }

  if (transform === "lowercase") {
    return "LOWER";
  }

  return "ORIGINAL";
}

async function resolveFontName(
  requestedFamily: string,
  requestedWeight: number,
  requestedStyle: "normal" | "italic"
): Promise<FontName> {
  const cacheKey = `${requestedFamily}|${requestedWeight}|${requestedStyle}`;
  const cached = fontLoadCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const availableFonts = await listAvailableFonts();
    const requestedFamilies = requestedFamily
      .split(",")
      .map((family) => family.replace(/["']/g, "").trim())
      .filter(Boolean);

    const preferredStyle = fontStyleFromWeight(requestedWeight, requestedStyle);

    for (const family of requestedFamilies) {
      const exactMatch = availableFonts.find(
        (font) =>
          font.fontName.family.toLowerCase() === family.toLowerCase() &&
          font.fontName.style.toLowerCase() === preferredStyle.toLowerCase()
      );

      if (exactMatch) {
        return exactMatch.fontName;
      }

      const familyMatch = availableFonts.find(
        (font) => font.fontName.family.toLowerCase() === family.toLowerCase()
      );

      if (familyMatch) {
        return familyMatch.fontName;
      }
    }

    const interMatch = availableFonts.find(
      (font) =>
        font.fontName.family === "Inter" &&
        font.fontName.style.toLowerCase() === preferredStyle.toLowerCase()
    );

    if (interMatch) {
      return interMatch.fontName;
    }

    return { family: "Inter", style: "Regular" };
  })();

  fontLoadCache.set(cacheKey, promise);
  return promise;
}

async function listAvailableFonts(): Promise<Font[]> {
  if (!availableFontsPromise) {
    availableFontsPromise = figma.listAvailableFontsAsync();
  }

  return availableFontsPromise;
}

function fontStyleFromWeight(
  weight: number,
  fontStyle: "normal" | "italic"
): string {
  const suffix = fontStyle === "italic" ? " Italic" : "";

  if (weight >= 800) {
    return `Extra Bold${suffix}`;
  }

  if (weight >= 700) {
    return `Bold${suffix}`;
  }

  if (weight >= 600) {
    return `Semi Bold${suffix}`;
  }

  if (weight >= 500) {
    return `Medium${suffix}`;
  }

  return fontStyle === "italic" ? "Italic" : "Regular";
}

function toSolidPaint(value: string): SolidPaint | null {
  const parsed = parseCssColor(value);

  if (!parsed) {
    return null;
  }

  return {
    type: "SOLID",
    color: parsed.color,
    opacity: parsed.opacity
  };
}

function parseCssColor(value: string): { color: RGB; opacity: number } | null {
  const color = value.trim().toLowerCase();

  if (!color || color === "transparent") {
    return null;
  }

  if (color.startsWith("#")) {
    return parseHexColor(color);
  }

  const rgbMatch = color.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/
  );

  if (rgbMatch) {
    const red = clamp(Number(rgbMatch[1]), 0, 255) / 255;
    const green = clamp(Number(rgbMatch[2]), 0, 255) / 255;
    const blue = clamp(Number(rgbMatch[3]), 0, 255) / 255;
    const opacity = rgbMatch[4] ? clamp(Number(rgbMatch[4]), 0, 1) : 1;

    return {
      color: { r: red, g: green, b: blue },
      opacity
    };
  }

  const srgbMatch = color.match(
    /^color\(\s*srgb\s+([\d.]+)(%?)\s+([\d.]+)(%?)\s+([\d.]+)(%?)(?:\s*\/\s*([\d.]+)(%?))?\s*\)$/
  );

  if (!srgbMatch) {
    return null;
  }

  const red = normalizeSrgbChannel(srgbMatch[1], srgbMatch[2]);
  const green = normalizeSrgbChannel(srgbMatch[3], srgbMatch[4]);
  const blue = normalizeSrgbChannel(srgbMatch[5], srgbMatch[6]);
  const opacity = srgbMatch[7]
    ? normalizeSrgbAlpha(srgbMatch[7], srgbMatch[8])
    : 1;

  return {
    color: { r: red, g: green, b: blue },
    opacity
  };
}

function parseHexColor(
  value: string
): { color: RGB; opacity: number } | null {
  const normalized = value.replace("#", "");

  if (![3, 4, 6, 8].includes(normalized.length)) {
    return null;
  }

  const expanded =
    normalized.length === 3 || normalized.length === 4
      ? normalized
          .split("")
          .map((character) => character + character)
          .join("")
      : normalized;

  const red = Number.parseInt(expanded.slice(0, 2), 16) / 255;
  const green = Number.parseInt(expanded.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(expanded.slice(4, 6), 16) / 255;
  const alpha =
    expanded.length === 8
      ? Number.parseInt(expanded.slice(6, 8), 16) / 255
      : 1;

  return {
    color: { r: red, g: green, b: blue },
    opacity: alpha
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeSrgbChannel(rawValue: string, suffix: string): number {
  const parsed = Number(rawValue);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  if (suffix === "%") {
    return clamp(parsed / 100, 0, 1);
  }

  return clamp(parsed, 0, 1);
}

function normalizeSrgbAlpha(rawValue: string, suffix: string): number {
  const parsed = Number(rawValue);

  if (!Number.isFinite(parsed)) {
    return 1;
  }

  if (suffix === "%") {
    return clamp(parsed / 100, 0, 1);
  }

  return clamp(parsed, 0, 1);
}
