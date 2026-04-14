import cors from "cors";
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { setInterval as setNodeInterval } from "node:timers";
import { chromium, type Browser, type Page } from "playwright";

import type {
  ImportMode,
  ImportRequest,
  ImportSnapshot,
  ScreenshotSlice,
  SnapshotImageNode,
  SnapshotNode,
  ViewportPreset
} from "../shared/contracts.js";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 3210);
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || undefined;
const CAPTURE_TTL_MS = 15 * 60 * 1000;
const MAX_SCREENSHOT_SLICE_HEIGHT = 2048;

type RemoteCaptureAsset = {
  kind: "remote";
  sourceUrl: string;
};

type InlineCaptureAsset = {
  kind: "inline";
  bytes: Buffer;
  contentType: string;
};

type CaptureAsset = RemoteCaptureAsset | InlineCaptureAsset;

type CaptureAssetStore = {
  createdAt: number;
  assets: Map<string, CaptureAsset>;
};

type RawTextNode = Extract<SnapshotNode, { kind: "text" }>;
type RawShapeNode = Extract<SnapshotNode, { kind: "shape" }>;
type RawImageNode = Omit<SnapshotImageNode, "assetUrl"> & { assetId: string };
type InlineAssetClip = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type RawSnapshot = Omit<
  ImportSnapshot,
  "nodes" | "captureId" | "mode" | "screenshotUrl" | "screenshotSlices"
> & {
  nodes: Array<RawShapeNode | RawTextNode | RawImageNode>;
  assets: Record<string, string>;
  inlineAssets: Record<string, InlineAssetClip>;
};

const app = express();
const captureAssets = new Map<string, CaptureAssetStore>();
let browserPromise: Promise<Browser> | null = null;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.post("/api/import", async (request, response) => {
  try {
    const body = request.body as Partial<ImportRequest>;
    const normalizedUrl = normalizeRequestedUrl(body.url);
    const mode = normalizeMode(body.mode);
    const preset = normalizePreset(body.preset);
    const viewport = viewportForPreset(preset);
    const captureId = randomUUID();
    const baseUrl = publicBaseUrl(request);
    const pagePreparationWarnings: string[] = [];

    const browser = await getBrowser();
    const page = await browser.newPage({
      viewport: {
        width: viewport.width,
        height: viewport.height
      },
      deviceScaleFactor: 1
    });

    try {
      await page.goto(normalizedUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000
      });
      await page.emulateMedia({ reducedMotion: "reduce" });
      try {
        await page.addStyleTag({
          content: `
            *,
            *::before,
            *::after {
              animation-duration: 0s !important;
              animation-delay: 0s !important;
              transition-duration: 0s !important;
              transition-delay: 0s !important;
              caret-color: transparent !important;
            }
          `
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (/content security policy|csp|unsafe-inline/i.test(message)) {
          pagePreparationWarnings.push(
            "The site blocked our animation-reduction style because of Content Security Policy. Import continued, but animated content may be less stable."
          );
        } else {
          throw error;
        }
      }

      try {
        await page.waitForLoadState("networkidle", { timeout: 6_000 });
      } catch {
        // Some sites keep long-lived requests open; importing can continue without networkidle.
      }

      await autoScrollPage(page);

      if (mode === "screenshot") {
        const screenshotMetadata = await page.evaluate(() => {
          const pageHeight = Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
            window.innerHeight
          );
          const transparentTokens = new Set([
            "transparent",
            "rgba(0, 0, 0, 0)",
            "rgba(0,0,0,0)"
          ]);
          const backgroundColor = getComputedStyle(document.body).backgroundColor.trim();

          return {
            title: document.title || location.hostname,
            url: location.href,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            pageHeight,
            backgroundColor: transparentTokens.has(backgroundColor)
              ? null
              : backgroundColor
          };
        });

        const screenshotSlices = await captureScreenshotSlices({
          page,
          captureId,
          baseUrl,
          pageHeight: screenshotMetadata.pageHeight,
          viewportWidth: screenshotMetadata.viewportWidth
        });

        const result: ImportSnapshot = {
          captureId,
          title: screenshotMetadata.title,
          url: screenshotMetadata.url,
          preset,
          mode,
          viewportWidth: screenshotMetadata.viewportWidth,
          viewportHeight: screenshotMetadata.viewportHeight,
          pageHeight: screenshotMetadata.pageHeight,
          backgroundColor: screenshotMetadata.backgroundColor,
          screenshotUrl:
            screenshotSlices.length === 1 ? screenshotSlices[0]?.assetUrl : undefined,
          screenshotSlices,
          warnings: [
            ...pagePreparationWarnings,
            screenshotSlices.length > 1
              ? `Screenshot mode is the most visually accurate option. This page was split into ${screenshotSlices.length} stacked image slices so Figma can import tall mobile captures safely.`
              : "Screenshot mode is the most visually accurate option. The imported result is a single image instead of editable text and layout layers."
          ],
          generatedAt: new Date().toISOString(),
          nodes: []
        };

        response.json(result);
        return;
      }

        const rawSnapshot = await page.evaluate(() => {
        const pageHeight = Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight,
          window.innerHeight
        );

        const warnings: string[] = [];
        const assets: Record<string, string> = {};
        const inlineAssets: Record<string, InlineAssetClip> = {};
        const nodes: RawSnapshot["nodes"] = [];
        let assetCount = 0;
        let nodeCount = 0;
        let rasterizedTextCount = 0;
        let inlineVisualCount = 0;

        const seenTextRects = new Set<string>();
        const seenShapeRects = new Set<string>();
        const transparentTokens = new Set([
            "transparent",
            "rgba(0, 0, 0, 0)",
            "rgba(0,0,0,0)"
        ]);
        const genericFontFamilies = [
          "inter",
          "sans-serif",
          "serif",
          "monospace",
          "system-ui",
          "-apple-system",
          "blinkmacsystemfont",
          "segoe ui",
          "helvetica",
          "arial",
          "roboto",
          "georgia",
          "times new roman",
          "sf pro",
          "noto sans"
        ];
        const ignoredShapeTags = new Set([
          "style",
          "script",
          "noscript",
          "meta",
          "link",
          "br"
        ]);
        const colorCanvas = document.createElement("canvas");
        colorCanvas.width = 1;
        colorCanvas.height = 1;
        const colorContext = colorCanvas.getContext("2d", {
          willReadFrequently: true
        });

        const isTransparentCssColor = (value: string): boolean => {
          const normalized = value.trim().toLowerCase();

          if (!normalized || normalized === "transparent") {
            return true;
          }

          if (
            normalized === "rgba(0, 0, 0, 0)" ||
            normalized === "rgba(0,0,0,0)" ||
            normalized === "rgb(0 0 0 / 0)" ||
            normalized === "rgb(0 0 0 / 0%)"
          ) {
            return true;
          }

          const rgbAlphaMatch = normalized.match(
            /^rgba?\(\s*[\d.]+(?:\s*,\s*[\d.]+){2}(?:\s*,\s*([\d.]+))?\s*\)$/
          );

          if (rgbAlphaMatch?.[1]) {
            return Number.parseFloat(rgbAlphaMatch[1]) <= 0.01;
          }

          const colorFunctionMatch = normalized.match(
            /^color\(\s*srgb\s+[\d.]+(?:%?)\s+[\d.]+(?:%?)\s+[\d.]+(?:%?)\s*\/\s*([\d.]+)(%?)\s*\)$/
          );

          if (colorFunctionMatch) {
            const alpha = Number.parseFloat(colorFunctionMatch[1]);
            return colorFunctionMatch[2] === "%" ? alpha <= 1 : alpha <= 0.01;
          }

          return transparentTokens.has(normalized);
        };

        const normalizeColor = (value: string): string | null => {
          const normalized = value.trim();

          if (!normalized || isTransparentCssColor(normalized)) {
            return null;
          }

          if (!colorContext || !CSS.supports("color", normalized)) {
            return normalized;
          }

          colorContext.globalCompositeOperation = "copy";
          colorContext.clearRect(0, 0, 1, 1);
          colorContext.fillStyle = "rgba(0, 0, 0, 0)";
          colorContext.fillRect(0, 0, 1, 1);
          colorContext.fillStyle = normalized;
          colorContext.fillRect(0, 0, 1, 1);

          const [red, green, blue, alphaByte] = colorContext.getImageData(0, 0, 1, 1).data;
          const alpha = Number((alphaByte / 255).toFixed(3));

          if (alpha <= 0.01) {
            return null;
          }

          if (alpha >= 0.999) {
            return `rgb(${red}, ${green}, ${blue})`;
          }

          return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
        };

        const toNumber = (value: string, fallback = 0): number => {
          const parsed = Number.parseFloat(value);
          return Number.isFinite(parsed) ? parsed : fallback;
        };

        const firstFamily = (fontFamily: string): string => {
          const [family] = fontFamily.split(",");
          return family?.replace(/["']/g, "").trim() || "Inter";
        };

        const isLikelySystemFont = (fontFamily: string): boolean => {
          const normalized = fontFamily.trim().toLowerCase();
          return genericFontFamilies.some((family) => normalized.includes(family));
        };

        const clampOpacity = (value: string): number => {
          const parsed = toNumber(value, 1);
          return Math.max(0, Math.min(parsed, 1));
        };

        const rectKey = (
          prefix: string,
          x: number,
          y: number,
          width: number,
          height: number
        ): string =>
          `${prefix}:${Math.round(x)}:${Math.round(y)}:${Math.round(width)}:${Math.round(height)}`;

        const normalizeTextContent = (value: string): string =>
          value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

        const clipFromBox = (
          x: number,
          y: number,
          width: number,
          height: number,
          padding = 0
        ): InlineAssetClip | null => {
          const maxWidth = Math.max(Math.ceil(window.innerWidth), 1);
          const maxHeight = Math.max(Math.ceil(pageHeight), 1);
          const clipX = Math.max(Math.floor(x - padding), 0);
          const clipY = Math.max(Math.floor(y - padding), 0);
          const desiredWidth = Math.max(Math.ceil(width + padding * 2), 1);
          const desiredHeight = Math.max(Math.ceil(height + padding * 2), 1);
          const clipWidth = Math.min(desiredWidth, Math.max(maxWidth - clipX, 0));
          const clipHeight = Math.min(desiredHeight, Math.max(maxHeight - clipY, 0));

          if (
            clipWidth < 1 ||
            clipHeight < 1 ||
            clipX >= maxWidth ||
            clipY >= maxHeight
          ) {
            return null;
          }

          return {
            x: clipX,
            y: clipY,
            width: clipWidth,
            height: clipHeight
          };
        };

        const extractSingleBackgroundUrl = (backgroundImage: string): string | null => {
          const normalized = backgroundImage.trim();

          if (!normalized || normalized === "none") {
            return null;
          }

          const match = normalized.match(/^url\(["']?(.*?)["']?\)$/);
          return match?.[1] ?? null;
        };

        const backgroundObjectFit = (
          backgroundSize: string
        ): "fill" | "contain" | "cover" => {
          if (backgroundSize.includes("contain")) {
            return "contain";
          }

          if (backgroundSize.includes("cover")) {
            return "cover";
          }

          return "fill";
        };

        const shouldCaptureElementAsInlineImage = (
          element: Element,
          style: CSSStyleDeclaration
        ): boolean => {
          if (
            element instanceof SVGSVGElement ||
            element instanceof HTMLCanvasElement ||
            element instanceof HTMLVideoElement
          ) {
            return true;
          }

          if (!(element instanceof HTMLElement)) {
            return false;
          }

          if (element.childElementCount > 0) {
            return false;
          }

          const hasComplexBackground =
            style.backgroundImage !== "none" &&
            !extractSingleBackgroundUrl(style.backgroundImage);
          const hasMask =
            style.getPropertyValue("mask-image") !== "none" ||
            style.getPropertyValue("-webkit-mask-image") !== "none";
          const hasFilter = style.filter !== "none" || style.backdropFilter !== "none";
          const hasClipPath = style.clipPath !== "none";
          const hasBlendMode = style.mixBlendMode !== "normal";
          const textContent = normalizeTextContent(element.innerText || element.textContent || "");

          return textContent.length === 0 && (
            hasComplexBackground ||
            hasMask ||
            hasFilter ||
            hasClipPath ||
            hasBlendMode
          );
        };

        const shouldRasterizeTextNode = (
          parent: HTMLElement,
          style: CSSStyleDeclaration,
          text: string,
          width: number
        ): boolean => {
          const fontFamily = firstFamily(style.fontFamily);
          const fontSize = toNumber(style.fontSize, 16);
          const letterSpacing =
            style.letterSpacing === "normal" ? 0 : toNumber(style.letterSpacing, 0);
          const tagName = parent.tagName.toLowerCase();

          return (
            !isLikelySystemFont(fontFamily) &&
            (tagName === "span" || tagName === "strong") &&
            text.length <= 140 &&
            width < window.innerWidth * 0.95 &&
            (fontSize >= 32 || Math.abs(letterSpacing) >= 0.5)
          );
        };

        const maybePushShape = (
          name: string,
          x: number,
          y: number,
          width: number,
          height: number,
          opacity: number,
          fillColor: string | null,
          borderColor: string | null,
          borderWidth: number,
          borderRadius: number
        ): void => {
          if (!fillColor && (!borderColor || borderWidth <= 0)) {
            return;
          }

          const key = rectKey("shape", x, y, width, height);

          if (seenShapeRects.has(key)) {
            return;
          }

          seenShapeRects.add(key);
          nodeCount += 1;

          nodes.push({
            kind: "shape",
            id: `shape-${nodeCount}`,
            name,
            x,
            y,
            width,
            height,
            opacity,
            fillColor,
            borderColor,
            borderWidth,
            borderRadius
          });
        };

        const bodyBackground = normalizeColor(getComputedStyle(document.body).backgroundColor);

        for (const element of Array.from(document.body.querySelectorAll("*"))) {
          const tagName = element.tagName.toLowerCase();

          if (ignoredShapeTags.has(tagName)) {
            continue;
          }

          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const x = rect.left + window.scrollX;
          const y = rect.top + window.scrollY;
          const width = rect.width;
          const height = rect.height;
          const opacity = clampOpacity(style.opacity);

          if (
            width < 2 ||
            height < 2 ||
            style.display === "none" ||
            style.visibility === "hidden" ||
            opacity < 0.05
          ) {
            continue;
          }

          const fillColor = normalizeColor(style.backgroundColor);
          const borderColor = normalizeColor(style.borderTopColor);
          const borderWidth = toNumber(style.borderTopWidth, 0);
          const borderRadius = toNumber(style.borderTopLeftRadius, 0);
          const name = `${tagName}-${nodeCount + 1}`;
          const backgroundImageUrl = extractSingleBackgroundUrl(style.backgroundImage);

          if (element instanceof HTMLImageElement && element.currentSrc) {
            const assetId = `asset-${++assetCount}`;
            assets[assetId] = new URL(element.currentSrc, location.href).toString();
            nodeCount += 1;

            nodes.push({
              kind: "image",
              id: `image-${nodeCount}`,
              name,
              x,
              y,
              width,
              height,
              opacity,
              assetId,
              borderRadius,
              objectFit:
                style.objectFit === "contain" || style.objectFit === "cover"
                  ? style.objectFit
                  : "fill",
              backgroundColor: fillColor
            });
            continue;
          }

          if (backgroundImageUrl) {
            const assetId = `asset-${++assetCount}`;
            assets[assetId] = new URL(backgroundImageUrl, location.href).toString();
            nodeCount += 1;

            nodes.push({
              kind: "image",
              id: `image-${nodeCount}`,
              name,
              x,
              y,
              width,
              height,
              opacity,
              assetId,
              borderRadius,
              objectFit: backgroundObjectFit(style.backgroundSize),
              backgroundColor: fillColor
            });
            continue;
          }

          if (shouldCaptureElementAsInlineImage(element, style)) {
            const clip = clipFromBox(x, y, width, height, 1);

            if (clip) {
              const assetId = `asset-${++assetCount}`;
              inlineAssets[assetId] = clip;
              inlineVisualCount += 1;
              nodeCount += 1;

              nodes.push({
                kind: "image",
                id: `image-${nodeCount}`,
                name: `${name}-snapshot`,
                x,
                y,
                width,
                height,
                opacity: 1,
                assetId,
                borderRadius,
                objectFit: "fill",
                backgroundColor: fillColor
              });
            }

            continue;
          }

          maybePushShape(
            name,
            x,
            y,
            width,
            height,
            opacity,
            fillColor,
            borderColor,
            borderWidth,
            borderRadius
          );
        }

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

        while (walker.nextNode()) {
          const textNode = walker.currentNode;
          const parent = textNode.parentElement;

          if (
            !parent ||
            parent.closest("script, style, noscript, svg, canvas, video")
          ) {
            continue;
          }

          const style = getComputedStyle(parent);
          const parentRect = parent.getBoundingClientRect();

          if (
            parentRect.width < 1 ||
            parentRect.height < 1 ||
            style.display === "none" ||
            style.visibility === "hidden" ||
            clampOpacity(style.opacity) < 0.05
          ) {
            continue;
          }

          const text = normalizeTextContent(textNode.textContent ?? "");

          if (!text) {
            continue;
          }

          const range = document.createRange();
          range.selectNodeContents(textNode);
          const rect = range.getBoundingClientRect();

          if (rect.width < 1 || rect.height < 1) {
            continue;
          }

          const x = rect.left + window.scrollX;
          const y = rect.top + window.scrollY;
          const width = rect.width;
          const height = rect.height;
          const opacity = clampOpacity(style.opacity);
          const textColor = normalizeColor(style.color);

          if (!textColor) {
            continue;
          }

          if (
            parent.childElementCount > 0 &&
            width > window.innerWidth * 1.25 &&
            text.length > 80
          ) {
            continue;
          }

          const key = rectKey("text", x, y, width, height) + `:${text}:${textColor}`;

          if (seenTextRects.has(key)) {
            continue;
          }

          seenTextRects.add(key);

          if (shouldRasterizeTextNode(parent, style, text, width)) {
            const clip = clipFromBox(x, y, width, height, 2);

            if (clip) {
              const assetId = `asset-${++assetCount}`;
              inlineAssets[assetId] = clip;
              rasterizedTextCount += 1;
              nodeCount += 1;

              nodes.push({
                kind: "image",
                id: `image-${nodeCount}`,
                name: `${parent.tagName.toLowerCase()}-${nodeCount}-text-snapshot`,
                x,
                y,
                width,
                height,
                opacity: 1,
                assetId,
                borderRadius: 0,
                objectFit: "fill",
                backgroundColor: null
              });
              continue;
            }
          }

          nodeCount += 1;
          nodes.push({
            kind: "text",
            id: `text-${nodeCount}`,
            name: `${parent.tagName.toLowerCase()}-${nodeCount}-text`,
            x,
            y,
            width,
            height,
            opacity,
            text,
            style: {
              fontFamily: firstFamily(style.fontFamily),
              fontSize: toNumber(style.fontSize, 16),
              fontWeight: toNumber(style.fontWeight, 400),
              fontStyle: style.fontStyle === "italic" ? "italic" : "normal",
              lineHeight:
                style.lineHeight === "normal"
                  ? toNumber(style.fontSize, 16) * 1.2
                  : toNumber(style.lineHeight, toNumber(style.fontSize, 16) * 1.2),
              letterSpacing:
                style.letterSpacing === "normal"
                  ? 0
                  : toNumber(style.letterSpacing, 0),
              textAlign:
                style.textAlign === "center" ||
                style.textAlign === "right" ||
                style.textAlign === "justify"
                  ? style.textAlign
                  : "left",
              textTransform:
                style.textTransform === "uppercase" ||
                style.textTransform === "lowercase" ||
                style.textTransform === "capitalize"
                  ? style.textTransform
                  : "none",
              color: textColor
            }
          });
        }

        if (Object.keys(assets).length + Object.keys(inlineAssets).length > 24) {
          warnings.push(
            "The page contains many visual assets. Some images may import more slowly in Figma."
          );
        }

        if (inlineVisualCount > 0) {
          warnings.push(
            `${inlineVisualCount} complex visual elements were captured as bitmap layers to preserve SVGs, icons, filters, masks, or decorative effects.`
          );
        }

        if (rasterizedTextCount > 0) {
          warnings.push(
            `${rasterizedTextCount} custom-font text fragments were rasterized to preserve layout and avoid Figma font fallback issues.`
          );
        }

        warnings.push(
          "This editable import is hybrid: simpler text and boxes stay editable, while harder visuals fall back to bitmap layers for better fidelity."
        );

        return {
          title: document.title || location.hostname,
          url: location.href,
          preset: window.innerWidth <= 500 ? "mobile" : "desktop",
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          pageHeight,
          backgroundColor: bodyBackground,
          nodes,
          warnings,
          generatedAt: new Date().toISOString(),
          assets,
          inlineAssets
        } satisfies RawSnapshot;
      });

      const assetEntries = new Map<string, CaptureAsset>(
        Object.entries(rawSnapshot.assets).map(([assetId, sourceUrl]) => [
          assetId,
          {
            kind: "remote",
            sourceUrl
          } satisfies CaptureAsset
        ])
      );

      let skippedInlineAssetCount = 0;

      for (const [assetId, clip] of Object.entries(rawSnapshot.inlineAssets)) {
        const safeClip = sanitizeScreenshotClip(
          clip,
          rawSnapshot.viewportWidth,
          rawSnapshot.pageHeight
        );

        if (!safeClip) {
          skippedInlineAssetCount += 1;
          continue;
        }

        try {
          const bytes = await page.screenshot({
            fullPage: true,
            clip: safeClip,
            type: "png"
          });

          assetEntries.set(assetId, {
            kind: "inline",
            bytes,
            contentType: "image/png"
          });
        } catch {
          skippedInlineAssetCount += 1;
        }
      }

      if (skippedInlineAssetCount > 0) {
        rawSnapshot.warnings.push(
          `${skippedInlineAssetCount} clipped visual fragments were skipped because they fell outside the captured page bounds.`
        );
      }

      if (pagePreparationWarnings.length > 0) {
        rawSnapshot.warnings.unshift(...pagePreparationWarnings);
      }

      captureAssets.set(captureId, {
        createdAt: Date.now(),
        assets: assetEntries
      });

      const snapshotNodes: SnapshotNode[] = [];

      for (const node of rawSnapshot.nodes) {
        if (node.kind !== "image") {
          snapshotNodes.push(node);
          continue;
        }

        if (!assetEntries.has(node.assetId)) {
          continue;
        }

        snapshotNodes.push({
          ...node,
          assetUrl: `${baseUrl}/api/assets/${captureId}/${node.assetId}`
        });
      }

      const result: ImportSnapshot = {
        captureId,
        title: rawSnapshot.title,
        url: rawSnapshot.url,
        preset,
        mode,
        viewportWidth: rawSnapshot.viewportWidth,
        viewportHeight: rawSnapshot.viewportHeight,
        pageHeight: rawSnapshot.pageHeight,
        backgroundColor: rawSnapshot.backgroundColor,
        screenshotUrl: undefined,
        warnings: rawSnapshot.warnings,
        generatedAt: rawSnapshot.generatedAt,
        nodes: snapshotNodes
      };

      response.json(result);
    } finally {
      await page.close();
    }
  } catch (error) {
    handleError(response, error);
  }
});

app.get("/api/assets/:captureId/:assetId", async (request, response) => {
  try {
    cleanupExpiredCaptures();

    const capture = captureAssets.get(request.params.captureId);
    const asset = capture?.assets.get(request.params.assetId);

    if (!capture || !asset) {
      response.status(404).send("Asset not found or expired.");
      return;
    }

    if (asset.kind === "inline") {
      response.setHeader("Content-Type", asset.contentType);
      response.setHeader("Cache-Control", "public, max-age=900");
      response.send(asset.bytes);
      return;
    }

    const upstream = await fetch(asset.sourceUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
      }
    });

    if (!upstream.ok) {
      response.status(upstream.status).send("Failed to proxy the remote asset.");
      return;
    }

    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    response.setHeader("Content-Type", contentType);
    response.setHeader("Cache-Control", "public, max-age=900");

    const buffer = Buffer.from(await upstream.arrayBuffer());
    response.send(buffer);
  } catch (error) {
    handleError(response, error);
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Capture service listening on http://${HOST}:${PORT}`);
});

server.on("close", async () => {
  const browser = await browserPromise?.catch(() => null);
  await browser?.close();
});

const cleanupTimer = setNodeInterval(
  cleanupExpiredCaptures,
  CAPTURE_TTL_MS
) as unknown as NodeJS.Timeout;
cleanupTimer.unref();

function publicBaseUrl(request: Request): string {
  return PUBLIC_BASE_URL ?? `${request.protocol}://${request.get("host")}`;
}

function normalizeRequestedUrl(input: string | undefined): string {
  if (!input) {
    throw new Error("Missing website URL.");
  }

  const parsed = new URL(input.trim());

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Website URL must start with http:// or https://");
  }

  return parsed.toString();
}

function normalizePreset(preset: ImportRequest["preset"] | undefined): ViewportPreset {
  return preset === "mobile" ? "mobile" : "desktop";
}

function normalizeMode(mode: ImportRequest["mode"] | undefined): ImportMode {
  return mode === "editable" ? "editable" : "screenshot";
}

function viewportForPreset(preset: ViewportPreset): { width: number; height: number } {
  return preset === "mobile"
    ? { width: 390, height: 844 }
    : { width: 1440, height: 1024 };
}


async function captureScreenshotSlices({
  page,
  captureId,
  baseUrl,
  pageHeight,
  viewportWidth
}: {
  page: Page;
  captureId: string;
  baseUrl: string;
  pageHeight: number;
  viewportWidth: number;
}): Promise<ScreenshotSlice[]> {
  const assets = new Map<string, CaptureAsset>();
  const slices: ScreenshotSlice[] = [];
  let index = 0;

  for (let y = 0; y < pageHeight; y += MAX_SCREENSHOT_SLICE_HEIGHT) {
    const height = Math.max(Math.min(MAX_SCREENSHOT_SLICE_HEIGHT, pageHeight - y), 1);
    const assetId = `page-screenshot-${index + 1}`;
    const bytes = await page.screenshot({
      fullPage: true,
      clip: {
        x: 0,
        y,
        width: Math.max(viewportWidth, 1),
        height
      },
      type: "png"
    });

    assets.set(assetId, {
      kind: "inline",
      bytes,
      contentType: "image/png"
    });
    slices.push({
      assetUrl: `${baseUrl}/api/assets/${captureId}/${assetId}`,
      y,
      height
    });
    index += 1;
  }

  captureAssets.set(captureId, {
    createdAt: Date.now(),
    assets
  });

  return slices;
}

async function autoScrollPage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const distance = Math.max(window.innerHeight * 0.9, 400);

    await new Promise<void>((resolve) => {
      let travelled = 0;

      const timer = window.setInterval(() => {
        window.scrollBy(0, distance);
        travelled += distance;

        if (travelled >= document.body.scrollHeight + window.innerHeight) {
          window.clearInterval(timer);
          resolve();
        }
      }, 125);
    });

    window.scrollTo(0, 0);
  });

  await page.waitForTimeout(250);
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true
    });
  }

  return browserPromise;
}

function cleanupExpiredCaptures(): void {
  const cutoff = Date.now() - CAPTURE_TTL_MS;

  for (const [captureId, capture] of captureAssets.entries()) {
    if (capture.createdAt < cutoff) {
      captureAssets.delete(captureId);
    }
  }
}

function sanitizeScreenshotClip(
  clip: InlineAssetClip,
  viewportWidth: number,
  pageHeight: number
): InlineAssetClip | null {
  const maxWidth = Math.max(Math.ceil(viewportWidth), 1);
  const maxHeight = Math.max(Math.ceil(pageHeight), 1);
  const x = Math.max(Math.floor(clip.x), 0);
  const y = Math.max(Math.floor(clip.y), 0);

  if (x >= maxWidth || y >= maxHeight) {
    return null;
  }

  const width = Math.min(Math.max(Math.ceil(clip.width), 1), maxWidth - x);
  const height = Math.min(Math.max(Math.ceil(clip.height), 1), maxHeight - y);

  if (width < 1 || height < 1) {
    return null;
  }

  return {
    x,
    y,
    width,
    height
  };
}

function handleError(response: Response, error: unknown): void {
  const rawMessage = error instanceof Error ? error.message : "Unexpected server error";
  const message = rawMessage.replace(/\u001b\[[0-9;]*m/g, "");
  response.status(400).send(message);
}
