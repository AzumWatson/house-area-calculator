const canvas = document.getElementById("floorCanvas");
const ctx = canvas.getContext("2d");

const elements = {
  orthMode: document.getElementById("orthMode"),
  alignToFinished: document.getElementById("alignToFinished"),
  innerOnly: document.getElementById("innerOnly"),
  closeThreshold: document.getElementById("closeThreshold"),
  scale: document.getElementById("scale"),
  wallThickness: document.getElementById("wallThickness"),
  undoBtn: document.getElementById("undoBtn"),
  closeBtn: document.getElementById("closeBtn"),
  resetBtn: document.getElementById("resetBtn"),
  polyCount: document.getElementById("polyCount"),
  totalArea: document.getElementById("totalArea"),
  statusText: document.getElementById("statusText"),
  segmentScope: document.getElementById("segmentScope"),
  segmentList: document.getElementById("segmentList"),
  selectedSegmentBox: document.getElementById("selectedSegmentBox"),
  selectedSegmentTitle: document.getElementById("selectedSegmentTitle"),
  selectedSegmentLength: document.getElementById("selectedSegmentLength"),
  applySelectedLengthBtn: document.getElementById("applySelectedLengthBtn"),
  menuToggleBtn: document.getElementById("menuToggleBtn"),
  closePanelBtn: document.getElementById("closePanelBtn"),
  panelBackdrop: document.getElementById("panelBackdrop"),
  toolAddBtn: document.getElementById("toolAddBtn"),
  toolMoveBtn: document.getElementById("toolMoveBtn"),
  toolDeleteBtn: document.getElementById("toolDeleteBtn"),
};

const state = {
  polygons: [],
  openPolylines: [],
  draftPoints: [],
  metrics: [],
  hover: null,
  preview: null,
  dragging: null,
  dragPointerId: null,
  selectedSegment: null,
  activeShape: null,
  labelHitboxes: [],
  history: [],
  browserUndoEntries: 0,
  ignoreNextPopstate: false,
  tool: "add",
  view: {
    zoom: 1,
    minZoom: 0.35,
    maxZoom: 6,
    offsetX: 0,
    offsetY: 0,
    panning: false,
    panPointerId: null,
    panLastScreen: null,
    pinchActive: false,
    pinchLastDistance: 0,
    pinchLastMid: null,
  },
  canvasDpr: 1,
  canvasWidthCss: 1,
  canvasHeightCss: 1,
};

const activePointers = new Map();
const EPSILON = 1e-8;
const MAX_HISTORY = 300;
const SETTINGS_STORAGE_KEY = "floor-area-settings-v2";
let suppressSettingsSave = false;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clonePoints(points) {
  return points.map((point) => ({ x: point.x, y: point.y }));
}

function clonePolygons(polygons) {
  return polygons.map((polygon) => ({
    points: clonePoints(polygon.points),
  }));
}

function cloneRef(ref) {
  if (!ref) {
    return null;
  }
  return { ...ref };
}

function createSnapshot() {
  return {
    polygons: clonePolygons(state.polygons),
    openPolylines: clonePolygons(state.openPolylines),
    draftPoints: clonePoints(state.draftPoints),
    selectedSegment: cloneRef(state.selectedSegment),
    activeShape: cloneRef(state.activeShape),
    view: {
      zoom: state.view.zoom,
      offsetX: state.view.offsetX,
      offsetY: state.view.offsetY,
    },
    tool: state.tool,
  };
}

function pushBrowserUndoEntry() {
  try {
    window.history.pushState({ floorAreaUndo: Date.now() }, "");
    state.browserUndoEntries += 1;
  } catch (error) {
    // Ignore history API errors.
  }
}

function saveHistoryStep() {
  state.history.push(createSnapshot());
  if (state.history.length > MAX_HISTORY) {
    state.history.shift();
  }
  pushBrowserUndoEntry();
}

function restoreSnapshot(snapshot) {
  state.polygons = clonePolygons(snapshot.polygons);
  state.openPolylines = clonePolygons(snapshot.openPolylines || []);
  state.draftPoints = clonePoints(snapshot.draftPoints);
  state.selectedSegment = cloneRef(snapshot.selectedSegment);
  state.activeShape = cloneRef(snapshot.activeShape);
  state.tool = snapshot.tool || "add";
  state.view.zoom = snapshot.view.zoom;
  state.view.offsetX = snapshot.view.offsetX;
  state.view.offsetY = snapshot.view.offsetY;

  state.preview = null;
  state.hover = null;
  state.dragging = null;
  state.dragPointerId = null;
  state.view.panning = false;
  state.view.panPointerId = null;
  state.view.panLastScreen = null;
  state.view.pinchActive = false;
  state.view.pinchLastDistance = 0;
  state.view.pinchLastMid = null;
  activePointers.clear();
}

function undoInternal() {
  if (state.history.length === 0) {
    return false;
  }

  const snapshot = state.history.pop();
  restoreSnapshot(snapshot);
  refresh();
  return true;
}

function consumeBrowserUndoEntryViaBack() {
  if (state.browserUndoEntries <= 0) {
    return;
  }
  state.ignoreNextPopstate = true;
  state.browserUndoEntries -= 1;
  try {
    window.history.back();
  } catch (error) {
    // Ignore history API errors.
  }
}

function undoAction() {
  const didUndo = undoInternal();
  if (!didUndo) {
    updateStatus("没有可撤销的操作。", false);
    return;
  }
  consumeBrowserUndoEntryViaBack();
}

function readNumber(input, fallback) {
  const value = Number.parseFloat(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function getScalePxPerMeter() {
  return clamp(readNumber(elements.scale, 40), 5, 300);
}

function getCloseThresholdPx() {
  return clamp(readNumber(elements.closeThreshold, 16), 4, 80);
}

function getWallThicknessMeter() {
  return Math.max(0, readNumber(elements.wallThickness, 0));
}

function getScreenPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function screenToWorld(screenPoint) {
  return {
    x: (screenPoint.x - state.view.offsetX) / state.view.zoom,
    y: (screenPoint.y - state.view.offsetY) / state.view.zoom,
  };
}

function worldToScreen(worldPoint) {
  return {
    x: worldPoint.x * state.view.zoom + state.view.offsetX,
    y: worldPoint.y * state.view.zoom + state.view.offsetY,
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function signedPolygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return sum / 2;
}

function polygonArea(points) {
  if (points.length < 3) {
    return 0;
  }
  return Math.abs(signedPolygonArea(points));
}

function polygonPerimeter(points, closed) {
  if (points.length < 2) {
    return 0;
  }

  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    total += distance(points[i], points[i + 1]);
  }

  if (closed && points.length > 2) {
    total += distance(points[points.length - 1], points[0]);
  }

  return total;
}

function polygonCentroid(points) {
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }

  const signedArea = signedPolygonArea(points);
  if (Math.abs(signedArea) < EPSILON) {
    let x = 0;
    let y = 0;
    for (const point of points) {
      x += point.x;
      y += point.y;
    }
    return {
      x: x / points.length,
      y: y / points.length,
    };
  }

  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    const cross = current.x * next.y - next.x * current.y;
    cx += (current.x + next.x) * cross;
    cy += (current.y + next.y) * cross;
  }

  const factor = 1 / (6 * signedArea);
  return {
    x: cx * factor,
    y: cy * factor,
  };
}

function buildSegments(points, closed) {
  const segments = [];
  if (points.length < 2) {
    return segments;
  }

  for (let i = 0; i < points.length - 1; i += 1) {
    segments.push({ start: i, end: i + 1 });
  }

  if (closed && points.length > 2) {
    segments.push({ start: points.length - 1, end: 0 });
  }

  return segments;
}

function snapOrthogonal(base, target) {
  const dx = target.x - base.x;
  const dy = target.y - base.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return { x: target.x, y: base.y };
  }
  return { x: base.x, y: target.y };
}

function distanceToSegment(point, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = point.x - a.x;
  const apy = point.y - a.y;
  const abLenSq = abx * abx + aby * aby;

  if (abLenSq < EPSILON) {
    return distance(point, a);
  }

  const t = clamp((apx * abx + apy * aby) / abLenSq, 0, 1);
  const closest = {
    x: a.x + abx * t,
    y: a.y + aby * t,
  };

  return distance(point, closest);
}

function lineIntersection(a1, a2, b1, b2) {
  const r = { x: a2.x - a1.x, y: a2.y - a1.y };
  const s = { x: b2.x - b1.x, y: b2.y - b1.y };
  const denominator = r.x * s.y - r.y * s.x;

  if (Math.abs(denominator) < EPSILON) {
    return null;
  }

  const qp = { x: b1.x - a1.x, y: b1.y - a1.y };
  const t = (qp.x * s.y - qp.y * s.x) / denominator;

  return {
    x: a1.x + t * r.x,
    y: a1.y + t * r.y,
  };
}

function offsetPolygonInward(points, offsetWorld) {
  if (points.length < 3 || offsetWorld <= 0) {
    return null;
  }

  const signedArea = signedPolygonArea(points);
  const orientation = signedArea >= 0 ? 1 : -1;
  const offsetLines = [];

  for (let i = 0; i < points.length; i += 1) {
    const start = points[i];
    const end = points[(i + 1) % points.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.hypot(dx, dy);

    if (len < EPSILON) {
      return null;
    }

    const nx = orientation * (-dy / len);
    const ny = orientation * (dx / len);

    offsetLines.push({
      p1: { x: start.x + nx * offsetWorld, y: start.y + ny * offsetWorld },
      p2: { x: end.x + nx * offsetWorld, y: end.y + ny * offsetWorld },
      nx,
      ny,
    });
  }

  const inner = [];

  for (let i = 0; i < points.length; i += 1) {
    const prevLine = offsetLines[(i - 1 + points.length) % points.length];
    const currLine = offsetLines[i];
    let intersection = lineIntersection(prevLine.p1, prevLine.p2, currLine.p1, currLine.p2);

    if (!intersection) {
      const vx = prevLine.nx + currLine.nx;
      const vy = prevLine.ny + currLine.ny;
      const vLen = Math.hypot(vx, vy);

      if (vLen < EPSILON) {
        intersection = {
          x: points[i].x + currLine.nx * offsetWorld,
          y: points[i].y + currLine.ny * offsetWorld,
        };
      } else {
        intersection = {
          x: points[i].x + (vx / vLen) * offsetWorld,
          y: points[i].y + (vy / vLen) * offsetWorld,
        };
      }
    }

    inner.push(intersection);
  }

  return inner;
}

function formatNum(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function roundRectPath(x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function isMobileView() {
  return window.matchMedia("(max-width: 900px)").matches;
}

function openPanel() {
  document.body.classList.add("panel-open");
}

function closePanel() {
  document.body.classList.remove("panel-open");
}

function updateStatus(text, warning) {
  elements.statusText.textContent = text;
  elements.statusText.classList.toggle("warn", Boolean(warning));
}

function saveSettings() {
  if (suppressSettingsSave) {
    return;
  }

  const payload = {
    orthMode: elements.orthMode.checked,
    alignToFinished: elements.alignToFinished.checked,
    innerOnly: elements.innerOnly.checked,
    closeThreshold: elements.closeThreshold.value,
    scale: elements.scale.value,
    wallThickness: elements.wallThickness.value,
  };

  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    // Ignore storage errors.
  }
}

function loadSettings() {
  let parsed = null;
  try {
    parsed = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) || "null");
  } catch (error) {
    parsed = null;
  }

  if (!parsed || typeof parsed !== "object") {
    return;
  }

  suppressSettingsSave = true;
  if (typeof parsed.orthMode === "boolean") {
    elements.orthMode.checked = parsed.orthMode;
  }
  if (typeof parsed.alignToFinished === "boolean") {
    elements.alignToFinished.checked = parsed.alignToFinished;
  }
  if (typeof parsed.innerOnly === "boolean") {
    elements.innerOnly.checked = parsed.innerOnly;
  }
  if (parsed.closeThreshold !== undefined) {
    elements.closeThreshold.value = String(parsed.closeThreshold);
  }
  if (parsed.scale !== undefined) {
    elements.scale.value = String(parsed.scale);
  }
  if (parsed.wallThickness !== undefined) {
    elements.wallThickness.value = String(parsed.wallThickness);
  }
  suppressSettingsSave = false;

}

function setTool(tool, options = {}) {
  const leavingAddMode = state.tool === "add" && tool !== "add";
  if (leavingAddMode && state.draftPoints.length >= 2) {
    parkDraftAsOpenPolyline();
  }

  state.tool = tool;
  elements.toolAddBtn.classList.toggle("active", tool === "add");
  elements.toolMoveBtn.classList.toggle("active", tool === "pan");
  elements.toolDeleteBtn.classList.toggle("active", tool === "delete");
  if (tool === "delete") {
    updateStatus("删除模式：点击任意线段即可删除。", false);
  } else if (tool === "pan") {
    updateStatus("移动模式：拖动画板，滚轮/双指可缩放。", false);
  } else {
    updateStatusUI();
  }
  if (!options.skipSave) {
    saveSettings();
  }
}

function segmentRefEquals(a, b) {
  if (!a || !b) {
    return false;
  }
  return (
    a.shape === b.shape &&
    a.segmentIndex === b.segmentIndex &&
    (a.polyIndex ?? -1) === (b.polyIndex ?? -1) &&
    (a.polylineIndex ?? -1) === (b.polylineIndex ?? -1)
  );
}

function getShapePoints(shapeRef) {
  if (!shapeRef) {
    return null;
  }
  if (shapeRef.shape === "draft") {
    return state.draftPoints;
  }
  if (shapeRef.shape === "open") {
    const openPolyline = state.openPolylines[shapeRef.polylineIndex];
    return openPolyline ? openPolyline.points : null;
  }
  const polygon = state.polygons[shapeRef.polyIndex];
  return polygon ? polygon.points : null;
}

function isShapeClosed(shapeRef) {
  return Boolean(shapeRef && shapeRef.shape === "poly");
}

function getSegmentsByShape(shapeRef) {
  const points = getShapePoints(shapeRef);
  if (!points) {
    return [];
  }
  return buildSegments(points, isShapeClosed(shapeRef));
}

function getSegmentEndpoints(shapeRef, segmentIndex) {
  const points = getShapePoints(shapeRef);
  if (!points) {
    return null;
  }

  const segments = getSegmentsByShape(shapeRef);
  const segment = segments[segmentIndex];
  if (!segment) {
    return null;
  }

  return {
    points,
    segment,
    startPoint: points[segment.start],
    endPoint: points[segment.end],
  };
}

function isSegmentValid(segmentRef) {
  if (!segmentRef) {
    return false;
  }
  const segments = getSegmentsByShape(segmentRef);
  return segmentRef.segmentIndex >= 0 && segmentRef.segmentIndex < segments.length;
}

function getAllSegmentRefs(options = {}) {
  const includeDraft = options.includeDraft !== false;
  const includeOpen = options.includeOpen !== false;
  const includePolygons = options.includePolygons !== false;
  const refs = [];

  if (includeDraft) {
    const draftSegments = buildSegments(state.draftPoints, false);
    for (let i = 0; i < draftSegments.length; i += 1) {
      refs.push({ shape: "draft", segmentIndex: i });
    }
  }

  if (includeOpen) {
    for (let p = 0; p < state.openPolylines.length; p += 1) {
      const segments = buildSegments(state.openPolylines[p].points, false);
      for (let i = 0; i < segments.length; i += 1) {
        refs.push({ shape: "open", polylineIndex: p, segmentIndex: i });
      }
    }
  }

  if (includePolygons) {
    for (let p = 0; p < state.polygons.length; p += 1) {
      const segments = buildSegments(state.polygons[p].points, true);
      for (let i = 0; i < segments.length; i += 1) {
        refs.push({ shape: "poly", polyIndex: p, segmentIndex: i });
      }
    }
  }

  return refs;
}

function getAllPointRefs(options = {}) {
  const includeDraft = options.includeDraft !== false;
  const includeOpen = options.includeOpen !== false;
  const includePolygons = options.includePolygons !== false;
  const refs = [];

  if (includeDraft) {
    for (let i = 0; i < state.draftPoints.length; i += 1) {
      refs.push({ shape: "draft", pointIndex: i });
    }
  }

  if (includeOpen) {
    for (let p = 0; p < state.openPolylines.length; p += 1) {
      const points = state.openPolylines[p].points;
      for (let i = 0; i < points.length; i += 1) {
        refs.push({ shape: "open", polylineIndex: p, pointIndex: i });
      }
    }
  }

  if (includePolygons) {
    for (let p = 0; p < state.polygons.length; p += 1) {
      const points = state.polygons[p].points;
      for (let i = 0; i < points.length; i += 1) {
        refs.push({ shape: "poly", polyIndex: p, pointIndex: i });
      }
    }
  }

  return refs;
}

function getPointByRef(pointRef) {
  if (!pointRef) {
    return null;
  }

  if (pointRef.shape === "draft") {
    return state.draftPoints[pointRef.pointIndex] || null;
  }

  if (pointRef.shape === "open") {
    const openPolyline = state.openPolylines[pointRef.polylineIndex];
    return openPolyline ? openPolyline.points[pointRef.pointIndex] || null : null;
  }

  const polygon = state.polygons[pointRef.polyIndex];
  return polygon ? polygon.points[pointRef.pointIndex] || null : null;
}

function describeShape(shapeRef) {
  if (!shapeRef) {
    return "对象";
  }
  if (shapeRef.shape === "draft") {
    return "当前草图";
  }
  if (shapeRef.shape === "open") {
    return `草图 ${shapeRef.polylineIndex + 1}`;
  }
  return `多边形 ${shapeRef.polyIndex + 1}`;
}

function describeSegment(shapeRef, segmentIndex) {
  if (!shapeRef) {
    return "边";
  }
  if (shapeRef.shape === "draft") {
    return `草图边 ${segmentIndex + 1}`;
  }
  if (shapeRef.shape === "open") {
    return `草图 ${shapeRef.polylineIndex + 1} 的边 ${segmentIndex + 1}`;
  }
  return `多边形 ${shapeRef.polyIndex + 1} 的边 ${segmentIndex + 1}`;
}

function getHitThresholdWorld(px) {
  return px / state.view.zoom;
}

function findPointRefAt(pointWorld, radiusPx = 10) {
  const radius = getHitThresholdWorld(radiusPx);

  for (let i = state.draftPoints.length - 1; i >= 0; i -= 1) {
    if (distance(pointWorld, state.draftPoints[i]) <= radius) {
      return { shape: "draft", pointIndex: i };
    }
  }

  for (let p = state.openPolylines.length - 1; p >= 0; p -= 1) {
    const points = state.openPolylines[p].points;
    for (let i = points.length - 1; i >= 0; i -= 1) {
      if (distance(pointWorld, points[i]) <= radius) {
        return { shape: "open", polylineIndex: p, pointIndex: i };
      }
    }
  }

  for (let p = state.polygons.length - 1; p >= 0; p -= 1) {
    const points = state.polygons[p].points;
    for (let i = points.length - 1; i >= 0; i -= 1) {
      if (distance(pointWorld, points[i]) <= radius) {
        return { shape: "poly", polyIndex: p, pointIndex: i };
      }
    }
  }

  return null;
}

function findSegmentRefNear(pointWorld, thresholdPx = 8) {
  const refs = getAllSegmentRefs({ includeDraft: true, includeOpen: true, includePolygons: true });
  const threshold = getHitThresholdWorld(thresholdPx);
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const ref of refs) {
    const endpoints = getSegmentEndpoints(ref, ref.segmentIndex);
    if (!endpoints) {
      continue;
    }

    const d = distanceToSegment(pointWorld, endpoints.startPoint, endpoints.endPoint);
    if (d < threshold && d < bestDistance) {
      bestDistance = d;
      best = ref;
    }
  }

  return best;
}

function getAlignmentSegmentRefs() {
  return getAllSegmentRefs({
    includeDraft: true,
    includeOpen: true,
    includePolygons: elements.alignToFinished.checked,
  });
}

function collectLengthCandidates() {
  const refs = getAlignmentSegmentRefs();
  const candidates = [];

  for (const ref of refs) {
    const endpoints = getSegmentEndpoints(ref, ref.segmentIndex);
    if (!endpoints) {
      continue;
    }

    const len = distance(endpoints.startPoint, endpoints.endPoint);
    if (len < EPSILON) {
      continue;
    }

    candidates.push({
      lengthWorld: len,
      ref,
      orientation:
        Math.abs(endpoints.endPoint.x - endpoints.startPoint.x) >=
        Math.abs(endpoints.endPoint.y - endpoints.startPoint.y)
          ? "horizontal"
          : "vertical",
    });
  }

  return candidates;
}

function findLengthMatch(targetLengthWorld, orientation) {
  const candidates = collectLengthCandidates();
  const scale = getScalePxPerMeter();
  const targetLengthMeter = targetLengthWorld / scale;
  const toleranceMeter = clamp(targetLengthMeter * 0.035, 0.12, 1.5);
  const tolerance = Math.max(getHitThresholdWorld(16), toleranceMeter * scale);

  let best = null;
  for (const candidate of candidates) {
    if (orientation && elements.orthMode.checked && candidate.orientation !== orientation) {
      continue;
    }

    const diff = Math.abs(candidate.lengthWorld - targetLengthWorld);
    if (diff > tolerance) {
      continue;
    }
    if (!best || diff < best.diff) {
      best = {
        ...candidate,
        diff,
      };
    }
  }

  return best;
}

function collectAxisCandidates() {
  const refs = getAlignmentSegmentRefs();
  const pointRefs = getAllPointRefs({
    includeDraft: true,
    includeOpen: true,
    includePolygons: elements.alignToFinished.checked,
  });
  const hValues = [];
  const vValues = [];
  const straightTolerance = getHitThresholdWorld(6);

  for (const ref of refs) {
    const endpoints = getSegmentEndpoints(ref, ref.segmentIndex);
    if (!endpoints) {
      continue;
    }

    const { startPoint, endPoint } = endpoints;
    const absDx = Math.abs(startPoint.x - endPoint.x);
    const absDy = Math.abs(startPoint.y - endPoint.y);
    const nearHorizontal = absDy <= Math.max(straightTolerance, absDx * 0.02);
    const nearVertical = absDx <= Math.max(straightTolerance, absDy * 0.02);

    if (nearHorizontal) {
      hValues.push({
        value: (startPoint.y + endPoint.y) / 2,
        ref,
        source: "segment",
      });
    }

    if (nearVertical) {
      vValues.push({
        value: (startPoint.x + endPoint.x) / 2,
        ref,
        source: "segment",
      });
    }
  }

  for (const pointRef of pointRefs) {
    const point = getPointByRef(pointRef);
    if (!point) {
      continue;
    }

    hValues.push({
      value: point.y,
      ref: pointRef,
      source: "point",
    });
    vValues.push({
      value: point.x,
      ref: pointRef,
      source: "point",
    });
  }

  return { hValues, vValues };
}

function findAxisSnap(pointWorld, orientation) {
  const { hValues, vValues } = collectAxisCandidates();
  const tolerance = getHitThresholdWorld(Math.max(18, getScalePxPerMeter() * 0.38));
  const candidates = [];

  const checkHorizontal = !elements.orthMode.checked || orientation === "vertical";
  const checkVertical = !elements.orthMode.checked || orientation === "horizontal";

  if (checkHorizontal) {
    for (const item of hValues) {
      candidates.push({
        type: "h",
        value: item.value,
        ref: item.ref,
        source: item.source,
        diff: Math.abs(pointWorld.y - item.value),
      });
    }
  }

  if (checkVertical) {
    for (const item of vValues) {
      candidates.push({
        type: "v",
        value: item.value,
        ref: item.ref,
        source: item.source,
        diff: Math.abs(pointWorld.x - item.value),
      });
    }
  }

  let best = null;
  for (const candidate of candidates) {
    if (candidate.diff > tolerance) {
      continue;
    }
    if (
      !best ||
      candidate.diff < best.diff ||
      (Math.abs(candidate.diff - best.diff) < EPSILON &&
        best.source === "segment" &&
        candidate.source === "point")
    ) {
      best = candidate;
    }
  }

  return best;
}

function refineSnapByLengthReference(base, point, orientation, lengthMatch) {
  if (!lengthMatch) {
    return point;
  }
  if (lengthMatch.orientation && lengthMatch.orientation !== orientation) {
    return point;
  }

  const endpoints = getSegmentEndpoints(lengthMatch.ref, lengthMatch.ref.segmentIndex);
  if (!endpoints) {
    return point;
  }

  const { startPoint, endPoint } = endpoints;
  const axisTolerance = getHitThresholdWorld(Math.max(18, getScalePxPerMeter() * 0.4));
  const lengthTolerance = getHitThresholdWorld(Math.max(14, getScalePxPerMeter() * 0.3));

  if (orientation === "horizontal") {
    const refY = (startPoint.y + endPoint.y) / 2;
    if (Math.abs(point.y - refY) <= axisTolerance) {
      point = { x: point.x, y: refY };
    }

    const direction = Math.sign(point.x - base.x);
    const candidates = [startPoint.x, endPoint.x];
    let bestX = null;
    let bestDiff = Number.POSITIVE_INFINITY;

    for (const candidateX of candidates) {
      if (direction !== 0 && Math.sign(candidateX - base.x) !== direction) {
        continue;
      }

      const lengthDiff = Math.abs(Math.abs(candidateX - base.x) - lengthMatch.lengthWorld);
      const diff = Math.abs(point.x - candidateX);
      if (lengthDiff <= lengthTolerance && diff <= axisTolerance && diff < bestDiff) {
        bestX = candidateX;
        bestDiff = diff;
      }
    }

    if (bestX !== null) {
      point = { x: bestX, y: point.y };
    }
  } else {
    const refX = (startPoint.x + endPoint.x) / 2;
    if (Math.abs(point.x - refX) <= axisTolerance) {
      point = { x: refX, y: point.y };
    }

    const direction = Math.sign(point.y - base.y);
    const candidates = [startPoint.y, endPoint.y];
    let bestY = null;
    let bestDiff = Number.POSITIVE_INFINITY;

    for (const candidateY of candidates) {
      if (direction !== 0 && Math.sign(candidateY - base.y) !== direction) {
        continue;
      }

      const lengthDiff = Math.abs(Math.abs(candidateY - base.y) - lengthMatch.lengthWorld);
      const diff = Math.abs(point.y - candidateY);
      if (lengthDiff <= lengthTolerance && diff <= axisTolerance && diff < bestDiff) {
        bestY = candidateY;
        bestDiff = diff;
      }
    }

    if (bestY !== null) {
      point = { x: point.x, y: bestY };
    }
  }

  return point;
}

function isNearDraftStart(pointWorld) {
  if (state.draftPoints.length < 3) {
    return false;
  }
  return distance(pointWorld, state.draftPoints[0]) <= getHitThresholdWorld(getCloseThresholdPx());
}

function buildDraftPreview(rawPointWorld) {
  if (state.draftPoints.length === 0) {
    return null;
  }

  const base = state.draftPoints[state.draftPoints.length - 1];
  let point = elements.orthMode.checked
    ? snapOrthogonal(base, rawPointWorld)
    : { x: rawPointWorld.x, y: rawPointWorld.y };

  const dx = point.x - base.x;
  const dy = point.y - base.y;
  const orientation = Math.abs(dx) >= Math.abs(dy) ? "horizontal" : "vertical";

  const axisSnap = findAxisSnap(point, orientation);
  if (axisSnap) {
    if (axisSnap.type === "h") {
      point.y = axisSnap.value;
    } else {
      point.x = axisSnap.value;
    }
  }

  let lengthWorld = distance(base, point);
  let lengthMatch = null;

  if (lengthWorld > EPSILON) {
    lengthMatch = findLengthMatch(lengthWorld, orientation);
    if (lengthMatch) {
      const ratio = lengthMatch.lengthWorld / lengthWorld;
      point = {
        x: base.x + (point.x - base.x) * ratio,
        y: base.y + (point.y - base.y) * ratio,
      };
      point = refineSnapByLengthReference(base, point, orientation, lengthMatch);
      lengthWorld = distance(base, point);
    }
  }

  let nearClose = false;
  if (isNearDraftStart(point)) {
    point = { x: state.draftPoints[0].x, y: state.draftPoints[0].y };
    lengthWorld = distance(base, point);
    nearClose = true;
  }

  return {
    base,
    point,
    lengthWorld,
    lengthMeter: lengthWorld / getScalePxPerMeter(),
    axisSnap,
    lengthMatch,
    nearClose,
  };
}

function getActiveShapeRef() {
  if (isSegmentValid(state.selectedSegment)) {
    if (state.selectedSegment.shape === "draft") {
      return { shape: "draft" };
    }
    if (state.selectedSegment.shape === "open") {
      return { shape: "open", polylineIndex: state.selectedSegment.polylineIndex };
    }
    return { shape: "poly", polyIndex: state.selectedSegment.polyIndex };
  }

  if (state.draftPoints.length > 0) {
    return { shape: "draft" };
  }

  if (state.activeShape && state.activeShape.shape === "poly") {
    if (state.polygons[state.activeShape.polyIndex]) {
      return { shape: "poly", polyIndex: state.activeShape.polyIndex };
    }
  }

  if (state.activeShape && state.activeShape.shape === "open") {
    if (state.openPolylines[state.activeShape.polylineIndex]) {
      return { shape: "open", polylineIndex: state.activeShape.polylineIndex };
    }
  }

  if (state.polygons.length > 0) {
    return { shape: "poly", polyIndex: state.polygons.length - 1 };
  }

  if (state.openPolylines.length > 0) {
    return { shape: "open", polylineIndex: state.openPolylines.length - 1 };
  }

  return null;
}

function computePolygonMetrics(points) {
  const scale = getScalePxPerMeter();
  const outerAreaSquareMeter = polygonArea(points) / (scale * scale);
  const perimeterMeter = polygonPerimeter(points, true) / scale;
  const wallThicknessMeter = getWallThicknessMeter();
  const wallThicknessWorld = wallThicknessMeter * scale;

  let innerAreaSquareMeter = 0;
  let innerPolygon = null;
  let warningMessage = "";

  if (wallThicknessMeter > 0) {
    innerPolygon = offsetPolygonInward(points, wallThicknessWorld);
    if (!innerPolygon) {
      warningMessage = "存在多边形内轮廓无法计算，请检查是否有重复点或墙厚过大。";
    } else {
      innerAreaSquareMeter = polygonArea(innerPolygon) / (scale * scale);
      if (innerAreaSquareMeter <= EPSILON || !Number.isFinite(innerAreaSquareMeter)) {
        innerAreaSquareMeter = 0;
        innerPolygon = null;
        warningMessage = "存在多边形墙厚过大，内面积接近 0。";
      }
    }
  }

  const finalAreaSquareMeter = elements.innerOnly.checked
    ? innerAreaSquareMeter
    : outerAreaSquareMeter;

  return {
    outerAreaSquareMeter,
    innerAreaSquareMeter,
    finalAreaSquareMeter,
    perimeterMeter,
    innerPolygon,
    warningMessage,
  };
}

function updateSummaryUI() {
  state.metrics = state.polygons.map((polygon) => computePolygonMetrics(polygon.points));

  const total = state.metrics.reduce((sum, metric) => sum + metric.finalAreaSquareMeter, 0);
  elements.polyCount.textContent = String(state.polygons.length);
  elements.totalArea.textContent = formatNum(total);
}

function updateStatusUI() {
  if (state.tool === "delete") {
    updateStatus("删除模式：点击线段即可删除。", false);
    return;
  }
  if (state.tool === "pan") {
    updateStatus("移动模式：拖动画板，滚轮/双指可缩放。", false);
    return;
  }

  let text = "添加模式：点击画布加点，可连续创建多个多边形。";
  let warning = false;

  if (state.preview && state.preview.nearClose) {
    text = "已接近起点，点击即可闭合当前多边形。";
  } else if (state.preview && (state.preview.lengthMatch || state.preview.axisSnap)) {
    const tips = [];
    if (state.preview.lengthMatch) {
      tips.push(`长度对齐到 ${formatNum(state.preview.lengthMeter)}m`);
    }
    if (state.preview.axisSnap) {
      if (state.preview.axisSnap.source === "point") {
        tips.push(state.preview.axisSnap.type === "h" ? "已对齐到点的水平投影" : "已对齐到点的垂直投影");
      } else {
        tips.push(state.preview.axisSnap.type === "h" ? "已贴合水平线" : "已贴合垂直线");
      }
    }
    text = tips.join("，");
  } else if (state.draftPoints.length > 0 && state.draftPoints.length < 3) {
    text = `当前草图点数 ${state.draftPoints.length}。切换“移动/删除”会自动暂存草图。`;
  } else if (state.draftPoints.length >= 3) {
    text = "可继续加点，回到起点自动闭合；也可暂存后稍后续画。";
  } else if (state.openPolylines.length > 0) {
    text = `当前有 ${state.openPolylines.length} 条开放草图，点击端点可继续绘制。`;
  }

  const warningMetric = state.metrics.find((metric) => metric.warningMessage);
  if (warningMetric && state.draftPoints.length === 0) {
    text = warningMetric.warningMessage;
    warning = true;
  }

  updateStatus(text, warning);
}

function syncSelectedSegmentBox() {
  if (!isSegmentValid(state.selectedSegment)) {
    elements.selectedSegmentBox.classList.add("hidden");
    return;
  }

  const endpoints = getSegmentEndpoints(state.selectedSegment, state.selectedSegment.segmentIndex);
  if (!endpoints) {
    elements.selectedSegmentBox.classList.add("hidden");
    return;
  }

  const lengthMeter = distance(endpoints.startPoint, endpoints.endPoint) / getScalePxPerMeter();
  elements.selectedSegmentTitle.textContent = describeSegment(
    state.selectedSegment,
    state.selectedSegment.segmentIndex
  );
  elements.selectedSegmentLength.value = lengthMeter.toFixed(2);
  elements.selectedSegmentBox.classList.remove("hidden");
}

function renderSegmentEditor() {
  const activeShape = getActiveShapeRef();

  if (!activeShape) {
    elements.segmentScope.textContent = "线段长度（可手动修改）";
    elements.segmentList.innerHTML = '<p class="empty">暂无线段</p>';
    elements.selectedSegmentBox.classList.add("hidden");
    return;
  }

  const points = getShapePoints(activeShape);
  const segments = getSegmentsByShape(activeShape);

  if (!points || segments.length === 0) {
    elements.segmentScope.textContent = `${describeShape(activeShape)}线段（可手动修改）`;
    elements.segmentList.innerHTML = '<p class="empty">当前对象暂无可编辑线段</p>';
    elements.selectedSegmentBox.classList.add("hidden");
    return;
  }

  elements.segmentScope.textContent = `${describeShape(activeShape)}线段（可手动修改）`;
  elements.segmentList.innerHTML = "";

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const start = points[segment.start];
    const end = points[segment.end];
    const lengthMeter = distance(start, end) / getScalePxPerMeter();

    const rowRef =
      activeShape.shape === "draft"
        ? { shape: "draft", segmentIndex: i }
        : activeShape.shape === "open"
        ? { shape: "open", polylineIndex: activeShape.polylineIndex, segmentIndex: i }
        : { shape: "poly", polyIndex: activeShape.polyIndex, segmentIndex: i };

    const row = document.createElement("div");
    row.className = `segment-row${segmentRefEquals(rowRef, state.selectedSegment) ? " active" : ""}`;

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = `边 ${i + 1}: 点${segment.start + 1} → 点${segment.end + 1}`;

    const input = document.createElement("input");
    input.type = "number";
    input.min = "0.01";
    input.step = "0.01";
    input.value = lengthMeter.toFixed(2);

    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.textContent = "应用";

    applyBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      applySegmentLength(rowRef, Number.parseFloat(input.value));
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        applySegmentLength(rowRef, Number.parseFloat(input.value));
      }
    });

    row.addEventListener("click", () => {
      state.selectedSegment = cloneRef(rowRef);
      if (rowRef.shape === "poly") {
        state.activeShape = { shape: "poly", polyIndex: rowRef.polyIndex };
      } else if (rowRef.shape === "open") {
        state.activeShape = { shape: "open", polylineIndex: rowRef.polylineIndex };
      } else {
        state.activeShape = { shape: "draft" };
      }
      syncSelectedSegmentBox();
      renderSegmentEditor();
      draw();
    });

    row.append(label, input, applyBtn);
    elements.segmentList.appendChild(row);
  }

  syncSelectedSegmentBox();
}

function applySegmentLength(segmentRef, lengthMeter) {
  if (!Number.isFinite(lengthMeter) || lengthMeter <= 0) {
    updateStatus("请输入大于 0 的长度。", true);
    return;
  }

  if (!isSegmentValid(segmentRef)) {
    return;
  }

  const endpoints = getSegmentEndpoints(segmentRef, segmentRef.segmentIndex);
  if (!endpoints) {
    return;
  }

  const { points, segment, startPoint, endPoint } = endpoints;
  const dx = endPoint.x - startPoint.x;
  const dy = endPoint.y - startPoint.y;
  const currentLength = Math.hypot(dx, dy);

  if (currentLength < EPSILON) {
    return;
  }

  let ux = dx / currentLength;
  let uy = dy / currentLength;

  if (elements.orthMode.checked) {
    if (Math.abs(dx) >= Math.abs(dy)) {
      ux = Math.sign(dx) || 1;
      uy = 0;
    } else {
      ux = 0;
      uy = Math.sign(dy) || 1;
    }
  }

  const newLength = lengthMeter * getScalePxPerMeter();
  const targetPoint = {
    x: startPoint.x + ux * newLength,
    y: startPoint.y + uy * newLength,
  };

  saveHistoryStep();
  points[segment.end] = targetPoint;
  state.selectedSegment = cloneRef(segmentRef);
  if (segmentRef.shape === "poly") {
    state.activeShape = { shape: "poly", polyIndex: segmentRef.polyIndex };
  } else if (segmentRef.shape === "open") {
    state.activeShape = { shape: "open", polylineIndex: segmentRef.polylineIndex };
  } else {
    state.activeShape = { shape: "draft" };
  }

  refresh();
}

function promptEditSegmentLength(segmentRef, currentLengthMeter) {
  const value = window.prompt(
    `${describeSegment(segmentRef, segmentRef.segmentIndex)} 长度（米）`,
    currentLengthMeter.toFixed(2)
  );

  if (value === null) {
    return;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    updateStatus("长度输入无效，请输入大于 0 的数字。", true);
    return;
  }

  applySegmentLength(segmentRef, parsed);
}

function splitOpenPolylineBySegment(points, segmentIndex) {
  const segments = buildSegments(points, false);
  const segment = segments[segmentIndex];
  if (!segment) {
    return [];
  }

  const left = points.slice(0, segment.start + 1);
  const right = points.slice(segment.end);
  const pieces = [];

  if (left.length >= 2) {
    pieces.push(clonePoints(left));
  }
  if (right.length >= 2) {
    pieces.push(clonePoints(right));
  }

  return pieces;
}

function openPolylineFromPolygonByRemovedEdge(points, segmentIndex) {
  const segments = buildSegments(points, true);
  const segment = segments[segmentIndex];
  if (!segment) {
    return [];
  }

  const ordered = [];
  let cursor = segment.end;
  ordered.push({ x: points[cursor].x, y: points[cursor].y });

  while (cursor !== segment.start) {
    cursor = (cursor + 1) % points.length;
    ordered.push({ x: points[cursor].x, y: points[cursor].y });
  }

  return ordered;
}

function finalizeDraftPolygon() {
  if (state.draftPoints.length < 3) {
    updateStatus("至少需要 3 个点才能闭合。", false);
    return false;
  }

  saveHistoryStep();

  state.polygons.push({
    points: clonePoints(state.draftPoints),
  });

  state.activeShape = { shape: "poly", polyIndex: state.polygons.length - 1 };
  state.draftPoints = [];
  state.preview = null;
  state.selectedSegment = null;
  refresh();
  return true;
}

function parkDraftAsOpenPolyline() {
  if (state.draftPoints.length < 2) {
    updateStatus("当前草图至少需要 2 个点才能暂存。", false);
    return false;
  }

  saveHistoryStep();

  state.openPolylines.push({
    points: clonePoints(state.draftPoints),
  });
  state.activeShape = { shape: "open", polylineIndex: state.openPolylines.length - 1 };
  state.draftPoints = [];
  state.preview = null;
  state.selectedSegment = null;
  refresh();
  return true;
}

function addDraftPoint(pointWorld) {
  saveHistoryStep();
  state.draftPoints.push({ x: pointWorld.x, y: pointWorld.y });
  state.preview = null;
  state.activeShape = { shape: "draft" };
  refresh();
}

function normalizeAfterOpenRemove(removedIndex) {
  if (state.activeShape && state.activeShape.shape === "open") {
    if (state.activeShape.polylineIndex === removedIndex) {
      state.activeShape = null;
    } else if (state.activeShape.polylineIndex > removedIndex) {
      state.activeShape.polylineIndex -= 1;
    }
  }

  if (state.selectedSegment && state.selectedSegment.shape === "open") {
    if (state.selectedSegment.polylineIndex === removedIndex) {
      state.selectedSegment = null;
    } else if (state.selectedSegment.polylineIndex > removedIndex) {
      state.selectedSegment.polylineIndex -= 1;
    }
  }
}

function activateOpenPolylineFromEndpoint(pointRef) {
  if (!pointRef || pointRef.shape !== "open") {
    return false;
  }

  const openPolyline = state.openPolylines[pointRef.polylineIndex];
  if (!openPolyline) {
    return false;
  }

  const lastIndex = openPolyline.points.length - 1;
  if (pointRef.pointIndex !== 0 && pointRef.pointIndex !== lastIndex) {
    return false;
  }

  saveHistoryStep();

  const points = clonePoints(openPolyline.points);
  if (pointRef.pointIndex === 0) {
    points.reverse();
  }

  state.openPolylines.splice(pointRef.polylineIndex, 1);
  normalizeAfterOpenRemove(pointRef.polylineIndex);

  state.draftPoints = points;
  state.preview = null;
  state.selectedSegment = null;
  state.activeShape = { shape: "draft" };
  refresh();
  return true;
}

function normalizeAfterPolygonRemove(removedIndex) {
  if (state.activeShape && state.activeShape.shape === "poly") {
    if (state.activeShape.polyIndex === removedIndex) {
      state.activeShape = null;
    } else if (state.activeShape.polyIndex > removedIndex) {
      state.activeShape.polyIndex -= 1;
    }
  }

  if (state.selectedSegment && state.selectedSegment.shape === "poly") {
    if (state.selectedSegment.polyIndex === removedIndex) {
      state.selectedSegment = null;
    } else if (state.selectedSegment.polyIndex > removedIndex) {
      state.selectedSegment.polyIndex -= 1;
    }
  }
}

function deleteSegment(segmentRef) {
  if (!isSegmentValid(segmentRef)) {
    return;
  }

  saveHistoryStep();

  if (segmentRef.shape === "draft") {
    const pieces = splitOpenPolylineBySegment(state.draftPoints, segmentRef.segmentIndex);
    state.draftPoints = pieces[0] ? clonePoints(pieces[0]) : [];

    for (let i = 1; i < pieces.length; i += 1) {
      state.openPolylines.push({ points: clonePoints(pieces[i]) });
    }

    if (state.draftPoints.length > 0) {
      state.activeShape = { shape: "draft" };
    } else if (state.openPolylines.length > 0) {
      state.activeShape = { shape: "open", polylineIndex: state.openPolylines.length - 1 };
    } else {
      state.activeShape = null;
    }
  } else if (segmentRef.shape === "open") {
    const openPolyline = state.openPolylines[segmentRef.polylineIndex];
    if (openPolyline) {
      const pieces = splitOpenPolylineBySegment(openPolyline.points, segmentRef.segmentIndex);
      state.openPolylines.splice(segmentRef.polylineIndex, 1);
      normalizeAfterOpenRemove(segmentRef.polylineIndex);

      let firstInserted = null;
      for (let i = 0; i < pieces.length; i += 1) {
        const insertIndex = segmentRef.polylineIndex + i;
        state.openPolylines.splice(insertIndex, 0, {
          points: clonePoints(pieces[i]),
        });
        if (firstInserted === null) {
          firstInserted = insertIndex;
        }
      }

      if (firstInserted !== null) {
        state.activeShape = { shape: "open", polylineIndex: firstInserted };
      } else if (state.draftPoints.length > 0) {
        state.activeShape = { shape: "draft" };
      } else {
        state.activeShape = null;
      }
    }
  } else {
    const polygon = state.polygons[segmentRef.polyIndex];
    if (polygon) {
      const opened = openPolylineFromPolygonByRemovedEdge(polygon.points, segmentRef.segmentIndex);
      state.polygons.splice(segmentRef.polyIndex, 1);
      normalizeAfterPolygonRemove(segmentRef.polyIndex);

      if (opened.length >= 2) {
        state.openPolylines.push({
          points: clonePoints(opened),
        });
        state.activeShape = { shape: "open", polylineIndex: state.openPolylines.length - 1 };
      } else if (state.draftPoints.length > 0) {
        state.activeShape = { shape: "draft" };
      } else {
        state.activeShape = null;
      }
    }
  }

  state.selectedSegment = null;
  state.preview = null;
  refresh();
}

function computeLabelRect(mid, textWidth, fontSizeWorld) {
  const width = textWidth + 10 / state.view.zoom;
  const height = (fontSizeWorld + 6 / state.view.zoom);
  return {
    x: mid.x - width / 2,
    y: mid.y - height / 2,
    width,
    height,
  };
}

function registerLabelHitbox(segmentRef, rect, lengthMeter) {
  state.labelHitboxes.push({
    segmentRef: cloneRef(segmentRef),
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    lengthMeter,
  });
}

function findLabelHit(pointWorld) {
  for (let i = state.labelHitboxes.length - 1; i >= 0; i -= 1) {
    const box = state.labelHitboxes[i];
    if (
      pointWorld.x >= box.x &&
      pointWorld.x <= box.x + box.width &&
      pointWorld.y >= box.y &&
      pointWorld.y <= box.y + box.height
    ) {
      return box;
    }
  }
  return null;
}

function drawGrid() {
  const worldGrid = clamp(getScalePxPerMeter(), 20, 120);
  const topLeft = screenToWorld({ x: 0, y: 0 });
  const bottomRight = screenToWorld({ x: state.canvasWidthCss, y: state.canvasHeightCss });

  const minX = Math.min(topLeft.x, bottomRight.x);
  const maxX = Math.max(topLeft.x, bottomRight.x);
  const minY = Math.min(topLeft.y, bottomRight.y);
  const maxY = Math.max(topLeft.y, bottomRight.y);

  const startX = Math.floor(minX / worldGrid) * worldGrid;
  const endX = Math.ceil(maxX / worldGrid) * worldGrid;
  const startY = Math.floor(minY / worldGrid) * worldGrid;
  const endY = Math.ceil(maxY / worldGrid) * worldGrid;

  ctx.save();
  ctx.strokeStyle = "#efe9de";
  ctx.lineWidth = 1 / state.view.zoom;

  for (let x = startX; x <= endX; x += worldGrid) {
    ctx.beginPath();
    ctx.moveTo(x, minY);
    ctx.lineTo(x, maxY);
    ctx.stroke();
  }

  for (let y = startY; y <= endY; y += worldGrid) {
    ctx.beginPath();
    ctx.moveTo(minX, y);
    ctx.lineTo(maxX, y);
    ctx.stroke();
  }

  ctx.restore();
}

function drawPolyline(points, closePath, strokeStyle, fillStyle, lineWidthPx) {
  if (points.length < 2) {
    return;
  }

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) {
    ctx.lineTo(points[i].x, points[i].y);
  }

  if (closePath) {
    ctx.closePath();
    if (fillStyle) {
      ctx.fillStyle = fillStyle;
      ctx.fill();
    }
  }

  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidthPx / state.view.zoom;
  ctx.stroke();
  ctx.restore();
}

function drawPoints(points, firstColor, defaultColor, radiusPx = 4) {
  const radius = radiusPx / state.view.zoom;
  for (let i = 0; i < points.length; i += 1) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(points[i].x, points[i].y, radius, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? firstColor : defaultColor;
    ctx.fill();
    ctx.restore();
  }
}

function drawSegmentLengthLabels(points, closed, textColor, shapeRef) {
  const segments = buildSegments(points, closed);
  const scale = getScalePxPerMeter();
  const fontSizeWorld = 12 / state.view.zoom;

  ctx.save();
  ctx.font = `${fontSizeWorld}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const start = points[segment.start];
    const end = points[segment.end];
    const lenWorld = distance(start, end);

    if (lenWorld * state.view.zoom < 24) {
      continue;
    }

    const mid = {
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2,
    };

    const lengthMeter = lenWorld / scale;
    const label = `${lengthMeter.toFixed(2)}m`;
    const textWidth = ctx.measureText(label).width;
    const rect = computeLabelRect(mid, textWidth, fontSizeWorld);

    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    roundRectPath(rect.x, rect.y, rect.width, rect.height, 4 / state.view.zoom);
    ctx.fill();
    ctx.strokeStyle = "rgba(117, 111, 100, 0.45)";
    ctx.lineWidth = 1 / state.view.zoom;
    ctx.stroke();

    ctx.fillStyle = textColor;
    ctx.fillText(label, mid.x, mid.y);

    const segmentRef =
      shapeRef.shape === "draft"
        ? { shape: "draft", segmentIndex: i }
        : shapeRef.shape === "open"
        ? { shape: "open", polylineIndex: shapeRef.polylineIndex, segmentIndex: i }
        : { shape: "poly", polyIndex: shapeRef.polyIndex, segmentIndex: i };

    registerLabelHitbox(segmentRef, rect, lengthMeter);
  }

  ctx.restore();
}

function drawAreaBadge(center, line1, line2) {
  const fontBig = 13 / state.view.zoom;
  const fontSmall = 12 / state.view.zoom;

  ctx.save();
  ctx.font = `bold ${fontBig}px sans-serif`;
  const width1 = ctx.measureText(line1).width;
  ctx.font = `${fontSmall}px sans-serif`;
  const width2 = ctx.measureText(line2).width;

  const badgeWidth = Math.max(width1, width2) + 18 / state.view.zoom;
  const badgeHeight = 36 / state.view.zoom;
  const x = center.x - badgeWidth / 2;
  const y = center.y - badgeHeight / 2;

  roundRectPath(x, y, badgeWidth, badgeHeight, 8 / state.view.zoom);
  ctx.fillStyle = "rgba(255, 250, 236, 0.95)";
  ctx.fill();
  ctx.strokeStyle = "rgba(183, 154, 101, 0.95)";
  ctx.lineWidth = 1 / state.view.zoom;
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.font = `bold ${fontBig}px sans-serif`;
  ctx.fillStyle = "#49391d";
  ctx.fillText(line1, center.x, y + 13 / state.view.zoom);

  ctx.font = `${fontSmall}px sans-serif`;
  ctx.fillStyle = "#5f4f35";
  ctx.fillText(line2, center.x, y + 26 / state.view.zoom);

  ctx.restore();
}

function drawPolygonInner(innerPolygon) {
  if (!innerPolygon || innerPolygon.length < 3) {
    return;
  }

  drawPolyline(
    innerPolygon,
    true,
    "rgba(203, 126, 15, 0.92)",
    "rgba(240, 168, 58, 0.14)",
    1.8
  );
}

function drawSelectedSegment() {
  if (!isSegmentValid(state.selectedSegment)) {
    return;
  }

  const endpoints = getSegmentEndpoints(state.selectedSegment, state.selectedSegment.segmentIndex);
  if (!endpoints) {
    return;
  }

  ctx.save();
  ctx.strokeStyle = state.tool === "delete" ? "#d2382a" : "#f0a83a";
  ctx.lineWidth = 4 / state.view.zoom;
  ctx.beginPath();
  ctx.moveTo(endpoints.startPoint.x, endpoints.startPoint.y);
  ctx.lineTo(endpoints.endPoint.x, endpoints.endPoint.y);
  ctx.stroke();
  ctx.restore();
}

function drawDraftPreview() {
  if (!state.preview || state.draftPoints.length === 0 || state.tool !== "add") {
    return;
  }

  const { base, point, lengthMeter, axisSnap, lengthMatch, nearClose } = state.preview;

  if (axisSnap) {
    const topLeft = screenToWorld({ x: 0, y: 0 });
    const bottomRight = screenToWorld({ x: state.canvasWidthCss, y: state.canvasHeightCss });

    ctx.save();
    ctx.setLineDash([6 / state.view.zoom, 6 / state.view.zoom]);
    ctx.strokeStyle = "rgba(12, 138, 79, 0.75)";
    ctx.lineWidth = 1.2 / state.view.zoom;
    ctx.beginPath();
    if (axisSnap.type === "h") {
      ctx.moveTo(topLeft.x, axisSnap.value);
      ctx.lineTo(bottomRight.x, axisSnap.value);
    } else {
      ctx.moveTo(axisSnap.value, topLeft.y);
      ctx.lineTo(axisSnap.value, bottomRight.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  if (lengthMatch) {
    const match = getSegmentEndpoints(lengthMatch.ref, lengthMatch.ref.segmentIndex);
    if (match) {
      ctx.save();
      ctx.setLineDash([8 / state.view.zoom, 5 / state.view.zoom]);
      ctx.strokeStyle = "rgba(13, 120, 88, 0.76)";
      ctx.lineWidth = 1.6 / state.view.zoom;
      ctx.beginPath();
      ctx.moveTo(match.startPoint.x, match.startPoint.y);
      ctx.lineTo(match.endPoint.x, match.endPoint.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  ctx.save();
  ctx.setLineDash([6 / state.view.zoom, 6 / state.view.zoom]);
  ctx.strokeStyle = nearClose ? "#0c8a4f" : "#638392";
  ctx.lineWidth = 1.6 / state.view.zoom;
  ctx.beginPath();
  ctx.moveTo(base.x, base.y);
  ctx.lineTo(point.x, point.y);
  ctx.stroke();
  ctx.restore();

  const mid = {
    x: (base.x + point.x) / 2,
    y: (base.y + point.y) / 2,
  };

  const lines = [`${formatNum(lengthMeter)}m`];
  if (lengthMatch) {
    lines.push(`对齐: ${describeSegment(lengthMatch.ref, lengthMatch.ref.segmentIndex)}`);
  }
  if (axisSnap) {
    if (axisSnap.source === "point") {
      lines.push(axisSnap.type === "h" ? "对齐点的水平投影" : "对齐点的垂直投影");
    } else {
      lines.push(axisSnap.type === "h" ? "贴合水平线" : "贴合垂直线");
    }
  }
  if (nearClose) {
    lines.push("点击闭合");
  }

  const fontSize = 12 / state.view.zoom;

  ctx.save();
  ctx.font = `${fontSize}px sans-serif`;
  const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) + 14 / state.view.zoom;
  const height = (18 + (lines.length - 1) * 14) / state.view.zoom;

  roundRectPath(mid.x - width / 2, mid.y - height / 2, width, height, 7 / state.view.zoom);
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  ctx.fill();
  ctx.strokeStyle = "rgba(120, 120, 120, 0.4)";
  ctx.lineWidth = 1 / state.view.zoom;
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${fontSize}px sans-serif`;

  for (let i = 0; i < lines.length; i += 1) {
    ctx.fillStyle = i === 0 ? "#274452" : "#4f5a60";
    ctx.fillText(lines[i], mid.x, mid.y - height / 2 + (10 + i * 14) / state.view.zoom);
  }

  ctx.restore();
}

function drawDraftPolygon() {
  if (state.draftPoints.length === 0) {
    return;
  }

  if (state.draftPoints.length >= 2) {
    drawPolyline(state.draftPoints, false, "#1f6c7d", null, 2);
  }

  drawSegmentLengthLabels(state.draftPoints, false, "#2f382f", { shape: "draft" });
  drawPoints(state.draftPoints, "#e63946", "#173f53", 4.8);

  if (state.draftPoints.length >= 3 && state.tool === "add") {
    const first = state.draftPoints[0];
    ctx.save();
    ctx.setLineDash([4 / state.view.zoom, 4 / state.view.zoom]);
    ctx.strokeStyle = "#0c8a4f";
    ctx.lineWidth = 1.2 / state.view.zoom;
    ctx.beginPath();
    ctx.arc(first.x, first.y, getCloseThresholdPx() / state.view.zoom, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  drawDraftPreview();
}

function drawOpenPolylines() {
  for (let i = 0; i < state.openPolylines.length; i += 1) {
    const polyline = state.openPolylines[i];
    const isActive =
      state.activeShape && state.activeShape.shape === "open" && state.activeShape.polylineIndex === i;

    drawPolyline(
      polyline.points,
      false,
      isActive ? "#0a6e80" : "#4f7c89",
      null,
      isActive ? 2.2 : 1.8
    );

    drawSegmentLengthLabels(polyline.points, false, "#314147", { shape: "open", polylineIndex: i });
    drawPoints(polyline.points, "#d04a55", "#3d5e69", 3.8);
  }
}

function drawPolygons() {
  for (let i = 0; i < state.polygons.length; i += 1) {
    const polygon = state.polygons[i];
    const metric = state.metrics[i];
    const isActive =
      state.activeShape && state.activeShape.shape === "poly" && state.activeShape.polyIndex === i;

    drawPolyline(
      polygon.points,
      true,
      isActive ? "#005f73" : "#1f6c7d",
      "rgba(31, 108, 125, 0.08)",
      isActive ? 2.4 : 1.9
    );

    drawPolygonInner(metric ? metric.innerPolygon : null);
    drawSegmentLengthLabels(polygon.points, true, "#3f3215", { shape: "poly", polyIndex: i });
    drawPoints(polygon.points, "#cf3e45", "#375869", 3.7);

    if (metric) {
      const center = polygonCentroid(polygon.points);
      const modeText = elements.innerOnly.checked ? "内面积" : "外面积";
      drawAreaBadge(center, `${formatNum(metric.finalAreaSquareMeter)}㎡`, `#${i + 1} ${modeText}`);
    }
  }
}

function drawSceneWorld() {
  state.labelHitboxes = [];
  drawGrid();
  drawPolygons();
  drawOpenPolylines();
  drawDraftPolygon();
  drawSelectedSegment();
}

function draw() {
  ctx.setTransform(state.canvasDpr, 0, 0, state.canvasDpr, 0, 0);
  ctx.clearRect(0, 0, state.canvasWidthCss, state.canvasHeightCss);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, state.canvasWidthCss, state.canvasHeightCss);

  ctx.save();
  ctx.translate(state.view.offsetX, state.view.offsetY);
  ctx.scale(state.view.zoom, state.view.zoom);
  drawSceneWorld();
  ctx.restore();
}

function refresh() {
  updateSummaryUI();

  if (state.selectedSegment && !isSegmentValid(state.selectedSegment)) {
    state.selectedSegment = null;
  }

  renderSegmentEditor();
  updateStatusUI();
  setTool(state.tool, { skipSave: true });
  draw();
}

function shouldStartPan(event) {
  if (event.pointerType === "touch") {
    return false;
  }
  return event.button === 1 || (event.button === 0 && event.altKey);
}

function startPan(pointerId, screenPoint) {
  state.view.panning = true;
  state.view.panPointerId = pointerId;
  state.view.panLastScreen = screenPoint;
}

function zoomAtScreenPoint(screenPoint, zoomFactor) {
  const oldZoom = state.view.zoom;
  const newZoom = clamp(oldZoom * zoomFactor, state.view.minZoom, state.view.maxZoom);
  if (Math.abs(newZoom - oldZoom) < EPSILON) {
    return;
  }

  const worldBefore = screenToWorld(screenPoint);
  state.view.zoom = newZoom;
  state.view.offsetX = screenPoint.x - worldBefore.x * newZoom;
  state.view.offsetY = screenPoint.y - worldBefore.y * newZoom;
}

function getTwoPointerInfo() {
  const points = [...activePointers.values()];
  if (points.length < 2) {
    return null;
  }

  const a = points[0];
  const b = points[1];
  const distancePx = Math.hypot(a.x - b.x, a.y - b.y);
  const mid = {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };

  return { distancePx, mid };
}

function handlePinchMove() {
  const info = getTwoPointerInfo();
  if (!info) {
    return;
  }

  if (!state.view.pinchActive) {
    state.view.pinchActive = true;
    state.view.pinchLastDistance = info.distancePx;
    state.view.pinchLastMid = info.mid;
    return;
  }

  if (state.view.pinchLastDistance > EPSILON) {
    const zoomFactor = info.distancePx / state.view.pinchLastDistance;
    zoomAtScreenPoint(info.mid, zoomFactor);
  }

  if (state.view.pinchLastMid) {
    const dx = info.mid.x - state.view.pinchLastMid.x;
    const dy = info.mid.y - state.view.pinchLastMid.y;
    state.view.offsetX += dx;
    state.view.offsetY += dy;
  }

  state.view.pinchLastDistance = info.distancePx;
  state.view.pinchLastMid = info.mid;
  draw();
}

function setActiveShapeFromRef(shapeRef) {
  if (!shapeRef) {
    state.activeShape = null;
    return;
  }

  if (shapeRef.shape === "poly") {
    state.activeShape = { shape: "poly", polyIndex: shapeRef.polyIndex };
    return;
  }

  if (shapeRef.shape === "open") {
    state.activeShape = { shape: "open", polylineIndex: shapeRef.polylineIndex };
    return;
  }

  state.activeShape = { shape: "draft" };
}

function handlePointerDown(event) {
  if (event.pointerType === "touch") {
    event.preventDefault();
  }

  const screenPoint = getScreenPoint(event);
  const worldPoint = screenToWorld(screenPoint);
  state.hover = worldPoint;

  activePointers.set(event.pointerId, screenPoint);

  if (isMobileView()) {
    closePanel();
  }

  if (event.pointerType === "touch" && activePointers.size >= 2) {
    state.view.pinchActive = false;
    state.view.panning = false;
    return;
  }

  if (state.tool === "pan") {
    startPan(event.pointerId, screenPoint);
    canvas.setPointerCapture(event.pointerId);
    return;
  }

  if (shouldStartPan(event)) {
    startPan(event.pointerId, screenPoint);
    canvas.setPointerCapture(event.pointerId);
    return;
  }

  if (state.tool === "delete") {
    const segmentToDelete = findSegmentRefNear(worldPoint, 12);
    if (segmentToDelete) {
      deleteSegment(segmentToDelete);
      return;
    }
    updateStatus("删除模式：点击线段即可删除。", false);
    return;
  }

  const labelHit = findLabelHit(worldPoint);
  if (labelHit) {
    state.selectedSegment = cloneRef(labelHit.segmentRef);
    setActiveShapeFromRef(labelHit.segmentRef);
    refresh();
    promptEditSegmentLength(labelHit.segmentRef, labelHit.lengthMeter);
    return;
  }

  const hitPoint = findPointRefAt(worldPoint, 10);
  if (state.draftPoints.length === 0 && hitPoint && hitPoint.shape === "open") {
    if (activateOpenPolylineFromEndpoint(hitPoint)) {
      return;
    }
  }

  if (hitPoint && (state.draftPoints.length === 0 || hitPoint.shape === "draft")) {
    saveHistoryStep();
    state.dragging = hitPoint;
    state.dragPointerId = event.pointerId;
    setActiveShapeFromRef(hitPoint);
    canvas.setPointerCapture(event.pointerId);
    return;
  }

  if (state.draftPoints.length === 0) {
    const hitSegment = findSegmentRefNear(worldPoint, 10);
    if (hitSegment) {
      state.selectedSegment = cloneRef(hitSegment);
      setActiveShapeFromRef(hitSegment);
      refresh();
      return;
    }
  }

  state.selectedSegment = null;

  if (state.draftPoints.length === 0) {
    addDraftPoint(worldPoint);
    return;
  }

  const preview = buildDraftPreview(worldPoint);
  state.preview = preview;

  if (preview && preview.nearClose) {
    finalizeDraftPolygon();
    return;
  }

  addDraftPoint(preview ? preview.point : worldPoint);
}

function handlePointerMove(event) {
  if (event.pointerType === "touch") {
    event.preventDefault();
  }

  const screenPoint = getScreenPoint(event);
  const worldPoint = screenToWorld(screenPoint);
  state.hover = worldPoint;

  if (activePointers.has(event.pointerId)) {
    activePointers.set(event.pointerId, screenPoint);
  }

  if (event.pointerType === "touch" && activePointers.size >= 2) {
    handlePinchMove();
    return;
  }

  if (state.view.panning && state.view.panPointerId === event.pointerId) {
    const dx = screenPoint.x - state.view.panLastScreen.x;
    const dy = screenPoint.y - state.view.panLastScreen.y;
    state.view.offsetX += dx;
    state.view.offsetY += dy;
    state.view.panLastScreen = screenPoint;
    draw();
    return;
  }

  if (state.dragging && state.dragPointerId === event.pointerId) {
    const points = getShapePoints(state.dragging);
    if (!points) {
      return;
    }

    points[state.dragging.pointIndex] = { x: worldPoint.x, y: worldPoint.y };
    refresh();
    return;
  }

  if (state.tool === "add" && state.draftPoints.length > 0) {
    state.preview = buildDraftPreview(worldPoint);
  } else {
    state.preview = null;
  }

  updateStatusUI();
  draw();
}

function handlePointerUpOrCancel(event) {
  if (event.pointerType === "touch") {
    event.preventDefault();
  }

  activePointers.delete(event.pointerId);

  if (activePointers.size < 2) {
    state.view.pinchActive = false;
    state.view.pinchLastDistance = 0;
    state.view.pinchLastMid = null;
  }

  if (state.view.panning && state.view.panPointerId === event.pointerId) {
    state.view.panning = false;
    state.view.panPointerId = null;
    state.view.panLastScreen = null;
  }

  if (state.dragging && state.dragPointerId === event.pointerId) {
    state.dragging = null;
    state.dragPointerId = null;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    refresh();
  }
}

function handleWheel(event) {
  event.preventDefault();
  const screenPoint = getScreenPoint(event);
  const factor = Math.exp(-event.deltaY * 0.0014);
  zoomAtScreenPoint(screenPoint, factor);
  draw();
}

function onConfigChange() {
  if (state.draftPoints.length > 0 && state.hover && state.tool === "add") {
    state.preview = buildDraftPreview(state.hover);
  }
  saveSettings();
  refresh();
}

function hasGeometry() {
  return state.polygons.length > 0 || state.openPolylines.length > 0 || state.draftPoints.length > 0;
}

function isEditableElement() {
  const active = document.activeElement;
  if (!active) {
    return false;
  }

  const tag = active.tagName ? active.tagName.toLowerCase() : "";
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    active.isContentEditable
  );
}

function setupKeyboardShortcuts() {
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closePanel();
      return;
    }

    if (isEditableElement()) {
      return;
    }

    const key = event.key.toLowerCase();
    const isUndoCombo = (event.ctrlKey || event.metaKey) && key === "z";
    const isBackspaceUndo = event.key === "Backspace";

    if (isUndoCombo || isBackspaceUndo) {
      event.preventDefault();
      undoAction();
      return;
    }

    if (key === "v") {
      setTool("add");
      return;
    }

    if (key === "m") {
      setTool("pan");
      return;
    }

    if (key === "x") {
      setTool("delete");
    }
  });
}

function setupBackUndoIntegration() {
  window.addEventListener("popstate", () => {
    if (state.ignoreNextPopstate) {
      state.ignoreNextPopstate = false;
      return;
    }

    if (state.history.length > 0) {
      state.browserUndoEntries = Math.max(0, state.browserUndoEntries - 1);
      undoInternal();
    }
  });
}

function setupPanelControls() {
  elements.menuToggleBtn.addEventListener("click", () => {
    if (document.body.classList.contains("panel-open")) {
      closePanel();
    } else {
      openPanel();
    }
  });

  elements.closePanelBtn.addEventListener("click", closePanel);
  elements.panelBackdrop.addEventListener("click", closePanel);

  window.addEventListener("resize", () => {
    resizeCanvasToDisplaySize();
    if (!isMobileView()) {
      closePanel();
    }
  });
}

function resizeCanvasToDisplaySize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const targetWidth = Math.max(1, Math.round(rect.width * dpr));
  const targetHeight = Math.max(1, Math.round(rect.height * dpr));

  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }

  state.canvasDpr = dpr;
  state.canvasWidthCss = rect.width;
  state.canvasHeightCss = rect.height;

  draw();
}

function resetPointerInteractionState() {
  activePointers.clear();
  state.view.pinchActive = false;
  state.view.pinchLastDistance = 0;
  state.view.pinchLastMid = null;
  state.view.panning = false;
  state.view.panPointerId = null;
  state.view.panLastScreen = null;
  state.dragging = null;
  state.dragPointerId = null;
}

function setupCanvasInteractions() {
  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", handlePointerUpOrCancel);
  canvas.addEventListener("pointercancel", handlePointerUpOrCancel);
  canvas.addEventListener("pointerleave", () => {
    if (state.dragging || state.view.panning || state.view.pinchActive) {
      return;
    }
    state.hover = null;
    state.preview = null;
    updateStatusUI();
    draw();
  });

  canvas.addEventListener("wheel", handleWheel, { passive: false });

  window.addEventListener("blur", () => {
    resetPointerInteractionState();
  });
}

elements.undoBtn.addEventListener("click", undoAction);

elements.closeBtn.addEventListener("click", () => {
  if (state.draftPoints.length >= 3) {
    finalizeDraftPolygon();
    return;
  }

  if (state.draftPoints.length >= 2) {
    parkDraftAsOpenPolyline();
    return;
  }

  updateStatus("当前草图点数不足，至少 2 点才可暂存，3 点可闭合为多边形。", false);
});

elements.resetBtn.addEventListener("click", () => {
  if (!hasGeometry()) {
    return;
  }

  saveHistoryStep();
  state.polygons = [];
  state.openPolylines = [];
  state.draftPoints = [];
  state.metrics = [];
  state.hover = null;
  state.preview = null;
  state.dragging = null;
  state.dragPointerId = null;
  state.selectedSegment = null;
  state.activeShape = null;
  refresh();
});

elements.applySelectedLengthBtn.addEventListener("click", () => {
  if (!state.selectedSegment) {
    return;
  }
  applySegmentLength(state.selectedSegment, Number.parseFloat(elements.selectedSegmentLength.value));
});

elements.selectedSegmentLength.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    elements.applySelectedLengthBtn.click();
  }
});

[
  elements.orthMode,
  elements.alignToFinished,
  elements.innerOnly,
  elements.closeThreshold,
  elements.scale,
  elements.wallThickness,
].forEach((input) => {
  input.addEventListener("change", onConfigChange);
  input.addEventListener("input", onConfigChange);
});

elements.toolAddBtn.addEventListener("click", () => setTool("add"));
elements.toolMoveBtn.addEventListener("click", () => setTool("pan"));
elements.toolDeleteBtn.addEventListener("click", () => setTool("delete"));

setupKeyboardShortcuts();
setupBackUndoIntegration();
setupPanelControls();
setupCanvasInteractions();
suppressSettingsSave = true;
setTool("add");
loadSettings();
suppressSettingsSave = false;
refresh();
saveSettings();
requestAnimationFrame(resizeCanvasToDisplaySize);
