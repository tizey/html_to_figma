export type ViewportPreset = "mobile" | "desktop";
export type ImportMode = "screenshot" | "editable";

export interface ImportRequest {
  url: string;
  preset: ViewportPreset;
  mode: ImportMode;
}

export interface ImportSnapshot {
  captureId: string;
  title: string;
  url: string;
  preset: ViewportPreset;
  mode: ImportMode;
  viewportWidth: number;
  viewportHeight: number;
  pageHeight: number;
  backgroundColor: string | null;
  screenshotUrl?: string;
  screenshotSlices?: ScreenshotSlice[];
  nodes: SnapshotNode[];
  warnings: string[];
  generatedAt: string;
}

export interface ScreenshotSlice {
  assetUrl: string;
  y: number;
  height: number;
}

export interface SnapshotBaseNode {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
}

export interface SnapshotShapeNode extends SnapshotBaseNode {
  kind: "shape";
  fillColor: string | null;
  borderColor: string | null;
  borderWidth: number;
  borderRadius: number;
}

export interface SnapshotTextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: "normal" | "italic";
  lineHeight: number;
  letterSpacing: number;
  textAlign: "left" | "center" | "right" | "justify";
  textTransform: "none" | "uppercase" | "lowercase" | "capitalize";
  color: string;
}

export interface SnapshotTextNode extends SnapshotBaseNode {
  kind: "text";
  text: string;
  style: SnapshotTextStyle;
}

export interface SnapshotImageNode extends SnapshotBaseNode {
  kind: "image";
  assetUrl: string;
  borderRadius: number;
  objectFit: "fill" | "contain" | "cover";
  backgroundColor: string | null;
}

export type SnapshotNode =
  | SnapshotShapeNode
  | SnapshotTextNode
  | SnapshotImageNode;
