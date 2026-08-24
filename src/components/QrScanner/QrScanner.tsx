import { useEffect, useRef, useState } from "react";
import jsQR, { type QRCode } from "jsqr";
import "./QrScanner.css";

type Phase = "A" | "A2" | "B" | "C" | "D" | "E";

interface Point {
  x: number;
  y: number;
}

interface Quad {
  tl: Point;
  tr: Point;
  bl: Point;
  br: Point;
}

// 中心座標+サイズ+回転角(ラジアン)で表す矩形。
// アイドル時(未検出)の固定サイズガイド(FULL_FRAME)専用の表現で、
// 検出後のガイド枠・固定画像は台形歪みに正確に沿わせるため Quad をそのまま使う。
interface Frame {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  angle: number;
}

interface TorchCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
}

interface TorchConstraintSet extends MediaTrackConstraintSet {
  torch?: boolean;
}

// 基準ステージサイズ 320x692 を前提にした座標(docs/qr_scanner_ui_spec.md 5章)
const STAGE_WIDTH = 320;
const FULL_FRAME: Frame = {
  centerX: 160,
  centerY: 340,
  width: 192,
  height: 192,
  angle: 0,
};

const TIMING = {
  bannerDelay: 700,
  stateB: 500,
  stateC: 100,
  stateD: 350,
  // stateB(確定タイマー)より必ず長くする。短いと確定前にロスト判定され、
  // A/Bを行き来してバナーや枠がちらつく。
  trackingLossLimit: 900,
  scanIntervalMs: 150,
} as const;

const SCAN_MAX_WIDTH = 480;

// L2(検出コードの固定画像)を切り出す際に四隅を重心から広げる倍率。
// QRコードのクワイエットゾーンを含めて欠けなくキャプチャするための余裕。
const SNAPSHOT_PADDING_SCALE = 1.0;

// スキャンガイド枠(L3)を検出QRコードの四隅から重心を保ったまま広げる倍率。
const GUIDE_PADDING_SCALE = 1.05;

// ガイド枠(L3)の追従を滑らかにする指数平滑の時定数(秒)。
// jsQR の4隅検出は150msごとにしか更新されずブレも含むため、CSSのtransitionには
// 頼らず(iOS Safari 等でSVGの d 属性のtransitionが効かない機種があるため)、
// requestAnimationFrame で毎フレーム連続的にこの時定数で目標へ近づける。
// 小さいほど追従が速く(ブレやすく)、大きいほど滑らか(遅延大)。
const GUIDE_FOLLOW_TAU_SECONDS = 0.08;

// ガイド枠(L3)の角ブラケットの長さ(各辺に対する比率、最小px)。
const GUIDE_CORNER_RATIO = 0.22;
const GUIDE_CORNER_MIN_LENGTH = 18;

function scaleFrame(frame: Frame, scale: number): Frame {
  return {
    centerX: frame.centerX * scale,
    centerY: frame.centerY * scale,
    width: frame.width * scale,
    height: frame.height * scale,
    angle: frame.angle,
  };
}

// 四隅を重心から scale 倍に拡大縮小する(形(台形の歪み)は保ったまま余白だけ足す)
function padQuadFromCentroid(quad: Quad, scale: number): Quad {
  const cx = (quad.tl.x + quad.tr.x + quad.bl.x + quad.br.x) / 4;
  const cy = (quad.tl.y + quad.tr.y + quad.bl.y + quad.br.y) / 4;
  const scalePoint = (p: Point): Point => ({
    x: cx + (p.x - cx) * scale,
    y: cy + (p.y - cy) * scale,
  });
  return {
    tl: scalePoint(quad.tl),
    tr: scalePoint(quad.tr),
    bl: scalePoint(quad.bl),
    br: scalePoint(quad.br),
  };
}

function quadBounds(quad: Quad) {
  const xs = [quad.tl.x, quad.tr.x, quad.bl.x, quad.br.x];
  const ys = [quad.tl.y, quad.tr.y, quad.bl.y, quad.br.y];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    minX,
    minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

// 三角形3点対応から、そのままアフィン変換(平行四辺形近似)の係数を Cramer の公式で求める。
// Canvas2D には射影変換(台形をそのまま扱う変換)が無いため、四角形を対角線で2枚の
// 三角形に分割し、それぞれをアフィン変換で描画することで疑似的に台形変形を再現する。
function affineFromTriangles(
  src: [Point, Point, Point],
  dst: [Point, Point, Point],
): { a: number; b: number; c: number; d: number; e: number; f: number } | null {
  const [p0, p1, p2] = src;
  const [q0, q1, q2] = dst;
  const denom =
    p0.x * (p1.y - p2.y) + p1.x * (p2.y - p0.y) + p2.x * (p0.y - p1.y);
  if (denom === 0) return null;

  const a =
    (q0.x * (p1.y - p2.y) + q1.x * (p2.y - p0.y) + q2.x * (p0.y - p1.y)) /
    denom;
  const c =
    (q0.x * (p2.x - p1.x) + q1.x * (p0.x - p2.x) + q2.x * (p1.x - p0.x)) /
    denom;
  const e =
    (q0.x * (p1.x * p2.y - p2.x * p1.y) +
      q1.x * (p2.x * p0.y - p0.x * p2.y) +
      q2.x * (p0.x * p1.y - p1.x * p0.y)) /
    denom;
  const b =
    (q0.y * (p1.y - p2.y) + q1.y * (p2.y - p0.y) + q2.y * (p0.y - p1.y)) /
    denom;
  const d =
    (q0.y * (p2.x - p1.x) + q1.y * (p0.x - p2.x) + q2.y * (p1.x - p0.x)) /
    denom;
  const f =
    (q0.y * (p1.x * p2.y - p2.x * p1.y) +
      q1.y * (p2.x * p0.y - p0.x * p2.y) +
      q2.y * (p0.x * p1.y - p1.x * p0.y)) /
    denom;

  return { a, b, c, d, e, f };
}

// jsQR が返す検出座標(取り込んだキャンバス基準)を、実際に表示されているカメラ映像
// (object-fit: cover)の座標系に変換する
function mapLocationToQuad(
  location: QRCode["location"],
  srcWidth: number,
  srcHeight: number,
  containerWidth: number,
  containerHeight: number,
): Quad {
  const scale = Math.max(
    containerWidth / srcWidth,
    containerHeight / srcHeight,
  );
  const offsetX = (containerWidth - srcWidth * scale) / 2;
  const offsetY = (containerHeight - srcHeight * scale) / 2;
  const map = (p: Point): Point => ({
    x: p.x * scale + offsetX,
    y: p.y * scale + offsetY,
  });

  return {
    tl: map(location.topLeftCorner),
    tr: map(location.topRightCorner),
    bl: map(location.bottomLeftCorner),
    br: map(location.bottomRightCorner),
  };
}

// アイドル時の固定サイズガイド(Frame)を、検出時と同じ Quad 表現に変換する。
function frameToQuad(frame: Frame): Quad {
  const hw = frame.width / 2;
  const hh = frame.height / 2;
  const cos = Math.cos(frame.angle);
  const sin = Math.sin(frame.angle);
  const rotate = (dx: number, dy: number): Point => ({
    x: frame.centerX + dx * cos - dy * sin,
    y: frame.centerY + dx * sin + dy * cos,
  });
  return {
    tl: rotate(-hw, -hh),
    tr: rotate(hw, -hh),
    bl: rotate(-hw, hh),
    br: rotate(hw, hh),
  };
}

function lerpPoint(a: Point, b: Point, alpha: number): Point {
  return { x: a.x + (b.x - a.x) * alpha, y: a.y + (b.y - a.y) * alpha };
}

// 表示中の四隅(prev)を目標の四隅(next)へ、頂点ごとに alpha だけ近づける。
// 角度という単一値を経由しないため、台形のまま(実際のパース歪みに沿ったまま)
// 滑らかに追従させられる。
function lerpQuad(prev: Quad, next: Quad, alpha: number): Quad {
  return {
    tl: lerpPoint(prev.tl, next.tl, alpha),
    tr: lerpPoint(prev.tr, next.tr, alpha),
    bl: lerpPoint(prev.bl, next.bl, alpha),
    br: lerpPoint(prev.br, next.br, alpha),
  };
}

// ガイド枠(L3)の角ブラケット1つ分の SVG パス("V"字)を、頂点から隣接2頂点への
// 辺に沿って一定の長さ(辺の比率、最小px)だけ伸ばして作る。
function cornerPath(vertex: Point, alongA: Point, alongB: Point): string {
  const pointToward = (to: Point): Point => {
    const dx = to.x - vertex.x;
    const dy = to.y - vertex.y;
    const edgeLength = Math.hypot(dx, dy);
    if (edgeLength === 0) return vertex;
    const t = Math.min(
      1,
      Math.max(GUIDE_CORNER_RATIO, GUIDE_CORNER_MIN_LENGTH / edgeLength),
    );
    return { x: vertex.x + dx * t, y: vertex.y + dy * t };
  };
  const a = pointToward(alongA);
  const b = pointToward(alongB);
  return `M ${a.x} ${a.y} L ${vertex.x} ${vertex.y} L ${b.x} ${b.y}`;
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function QrScanner() {
  const [phase, setPhase] = useState<Phase>("A");
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [detectedQuad, setDetectedQuad] = useState<Quad | null>(null);
  const [resultText, setResultText] = useState("");
  const [containerSize, setContainerSize] = useState({
    width: STAGE_WIDTH,
    height: 692,
  });
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);
  const [snapshotBox, setSnapshotBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const snapshotCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastSeenAtRef = useRef(0);
  const pendingTextRef = useRef("");
  // captureSnapshot 用に、パディング前の生の4隅座標を保持する。
  // ガイド枠(L3)は目標(パディング後)へ滑らかに追従させた Quad を表示に使うが、
  // 固定画像(L2)は本物の台形(パース)歪みに正確に沿わせたいため、
  // ここは加工されていない座標が必要。
  const detectedQuadRef = useRef<Quad | null>(null);
  // ガイド枠(L3)の追従アニメーション用。target は現在の目標形状(idle/パディング後の
  // 検出形状)、display は毎フレーム target へ近づけていく実際の表示形状。
  const guideTargetQuadRef = useRef<Quad | null>(null);
  const guideDisplayQuadRef = useRef<Quad | null>(null);
  const guideCornerRefs = useRef<(SVGPathElement | null)[]>([]);
  const containerSizeRef = useRef({ width: STAGE_WIDTH, height: 692 });

  useEffect(() => {
    let cancelled = false;

    navigator.mediaDevices
      ?.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setCameraReady(true);
      })
      .catch(() => setCameraError(true));

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const next = { width: el.clientWidth, height: el.clientHeight };
      containerSizeRef.current = next;
      setContainerSize(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ガイド枠(L3)の追従アニメーション。CSSの transition は、SVGの d 属性の
  // 補間に対応していない(または不安定な)ブラウザ(iOS Safari 等)があるため、
  // 毎フレーム自前で目標(guideTargetQuadRef)へ指数平滑しつつ DOM の d 属性を
  // 直接書き換える。
  useEffect(() => {
    let rafId: number;
    let lastTime: number | null = null;

    const step = (time: number) => {
      const target = guideTargetQuadRef.current;
      if (target) {
        const dt = lastTime === null ? 0 : (time - lastTime) / 1000;
        const display = guideDisplayQuadRef.current;
        const next =
          !display || dt <= 0
            ? target
            : lerpQuad(
                display,
                target,
                1 - Math.exp(-dt / GUIDE_FOLLOW_TAU_SECONDS),
              );
        guideDisplayQuadRef.current = next;

        const paths = [
          cornerPath(next.tl, next.tr, next.bl),
          cornerPath(next.tr, next.tl, next.br),
          cornerPath(next.bl, next.br, next.tl),
          cornerPath(next.br, next.bl, next.tr),
        ];
        guideCornerRefs.current.forEach((el, index) => {
          el?.setAttribute("d", paths[index]);
        });
      }
      lastTime = time;
      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const reset = () => {
    setPhase("A");
    setCopyFeedback(false);
    setDetectedQuad(null);
    setResultText("");
    setSnapshotUrl(null);
    setSnapshotBox(null);
    detectedQuadRef.current = null;
    guideDisplayQuadRef.current = null;
    pendingTextRef.current = "";
  };

  useEffect(() => {
    if (phase !== "A") return;
    const timer = setTimeout(() => setPhase("A2"), TIMING.bannerDelay);
    return () => clearTimeout(timer);
  }, [phase]);

  // 状態B→C: コード領域をその瞬間の静止画としてキャプチャし(L2)、以降は
  // ライブ映像(L1)がボケても検出済みコードだけは鮮明なまま固定表示する。
  // カメラを斜めから構えるとコードは正方形ではなく台形(遠近変形)に写るため、
  // 単純な回転だけでなく実際の4隅の座標に沿わせて画像自体を変形させる。
  // Canvas2D は射影変換を直接扱えないので、対角線(tr-bl)で2枚の三角形に
  // 分割しそれぞれをアフィン変換で描画する近似(ピースワイズ・アフィン)を使う。
  const captureSnapshot = () => {
    const video = videoRef.current;
    const quad = detectedQuadRef.current;
    if (!video || !quad || video.videoWidth === 0) return;

    const { width: containerWidth, height: containerHeight } =
      containerSizeRef.current;
    const scale = Math.max(
      containerWidth / video.videoWidth,
      containerHeight / video.videoHeight,
    );
    const offsetX = (containerWidth - video.videoWidth * scale) / 2;
    const offsetY = (containerHeight - video.videoHeight * scale) / 2;
    const toVideoSpace = (p: Point): Point => ({
      x: (p.x - offsetX) / scale,
      y: (p.y - offsetY) / scale,
    });

    const paddedQuad = padQuadFromCentroid(quad, SNAPSHOT_PADDING_SCALE);
    const bounds = quadBounds(paddedQuad);
    if (bounds.width <= 0 || bounds.height <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas =
      snapshotCanvasRef.current ?? document.createElement("canvas");
    snapshotCanvasRef.current = canvas;
    canvas.width = Math.max(1, Math.round(bounds.width * dpr));
    canvas.height = Math.max(1, Math.round(bounds.height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 描画先(キャンバス内、パディング込みの台形の各頂点)
    const dst = {
      tl: {
        x: (paddedQuad.tl.x - bounds.minX) * dpr,
        y: (paddedQuad.tl.y - bounds.minY) * dpr,
      },
      tr: {
        x: (paddedQuad.tr.x - bounds.minX) * dpr,
        y: (paddedQuad.tr.y - bounds.minY) * dpr,
      },
      bl: {
        x: (paddedQuad.bl.x - bounds.minX) * dpr,
        y: (paddedQuad.bl.y - bounds.minY) * dpr,
      },
      br: {
        x: (paddedQuad.br.x - bounds.minX) * dpr,
        y: (paddedQuad.br.y - bounds.minY) * dpr,
      },
    };
    // 元映像(動画ソース座標系)での同じ頂点
    const src = {
      tl: toVideoSpace(paddedQuad.tl),
      tr: toVideoSpace(paddedQuad.tr),
      bl: toVideoSpace(paddedQuad.bl),
      br: toVideoSpace(paddedQuad.br),
    };

    const drawTriangle = (
      srcTri: [Point, Point, Point],
      dstTri: [Point, Point, Point],
    ) => {
      const m = affineFromTriangles(srcTri, dstTri);
      if (!m) return;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(dstTri[0].x, dstTri[0].y);
      ctx.lineTo(dstTri[1].x, dstTri[1].y);
      ctx.lineTo(dstTri[2].x, dstTri[2].y);
      ctx.closePath();
      ctx.clip();
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
      ctx.drawImage(video, 0, 0);
      ctx.restore();
    };

    drawTriangle([src.tl, src.tr, src.bl], [dst.tl, dst.tr, dst.bl]);
    drawTriangle([src.tr, src.br, src.bl], [dst.tr, dst.br, dst.bl]);

    setSnapshotBox({
      left: bounds.minX,
      top: bounds.minY,
      width: bounds.width,
      height: bounds.height,
    });
    setSnapshotUrl(canvas.toDataURL("image/png"));
  };

  useEffect(() => {
    if (phase !== "B") return;
    const timer = setTimeout(() => {
      setResultText(pendingTextRef.current);
      captureSnapshot();
      setPhase("C");
    }, TIMING.stateB);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // 状態Bでロックオン中にコードを見失った場合は探索状態へ戻す
  useEffect(() => {
    if (phase !== "B") return;
    const interval = setInterval(() => {
      if (
        performance.now() - lastSeenAtRef.current >
        TIMING.trackingLossLimit
      ) {
        setPhase("A");
        setDetectedQuad(null);
        guideDisplayQuadRef.current = null;
      }
    }, TIMING.scanIntervalMs);
    return () => clearInterval(interval);
  }, [phase]);

  useEffect(() => {
    if (phase !== "C") return;
    const timer = setTimeout(() => setPhase("D"), TIMING.stateC);
    return () => clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "D") return;
    const timer = setTimeout(() => setPhase("E"), TIMING.stateD);
    return () => clearTimeout(timer);
  }, [phase]);

  // カメラ映像を定期的にキャンバスへ取り込み、実際にQRコードをデコードする
  useEffect(() => {
    if (!cameraReady) return;
    if (phase === "C" || phase === "D" || phase === "E") return;

    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas");
    }
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    const tick = () => {
      const video = videoRef.current;
      if (
        !video ||
        video.readyState < video.HAVE_CURRENT_DATA ||
        video.videoWidth === 0
      )
        return;

      const scale = Math.min(1, SCAN_MAX_WIDTH / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: "dontInvert",
      });
      if (!code) return;

      lastSeenAtRef.current = performance.now();
      pendingTextRef.current = code.data;
      const quad = mapLocationToQuad(
        code.location,
        canvas.width,
        canvas.height,
        containerSize.width,
        containerSize.height,
      );
      detectedQuadRef.current = quad;
      setDetectedQuad(quad);
      setPhase((current) =>
        current === "A" || current === "A2" ? "B" : current,
      );
    };

    const id = setInterval(tick, TIMING.scanIntervalMs);
    return () => clearInterval(id);
  }, [cameraReady, phase, containerSize]);

  const handleTorchToggle = () => {
    setTorchOn((prev) => {
      const next = !prev;
      const track = streamRef.current?.getVideoTracks()[0];
      const capabilities = track?.getCapabilities?.() as
        | TorchCapabilities
        | undefined;
      if (track && capabilities?.torch) {
        track
          .applyConstraints({
            advanced: [{ torch: next } as TorchConstraintSet],
          })
          .catch(() => {});
      }
      return next;
    });
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(resultText);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    } catch {
      // クリップボード API が使えない環境ではフィードバックのみ諦める
    }
  };

  const stageScale = containerSize.width / STAGE_WIDTH;
  const bannerVisible = phase === "A2" || phase === "B";
  const sheetOpen = phase === "E";
  const resultIsUrl = isUrl(resultText);
  const primaryActionHref = resultIsUrl
    ? resultText
    : `https://www.google.com/search?q=${encodeURIComponent(resultText)}`;
  const primaryActionLabel = resultIsUrl ? "サイトを開く" : "Webを検索";

  // 状態B以降: jsQR が返すバウンディングボックスは既にQRコード部分のみの
  // タイトな範囲なので、これ以上縮小せずそのまま使う(縮小すると枠がコードに食い込む)。
  // ガイド枠(L3)は台形(パース)歪みに正確に沿わせるため、単一の回転矩形ではなく
  // 検出した4隅そのもの(Quad)を表示に使う。
  const idleQuad = frameToQuad(scaleFrame(FULL_FRAME, stageScale));
  const paddedDetectedQuad = detectedQuad
    ? padQuadFromCentroid(detectedQuad, GUIDE_PADDING_SCALE)
    : null;
  const guideQuad: Quad =
    phase === "A" || phase === "A2"
      ? idleQuad
      : (paddedDetectedQuad ?? idleQuad);

  useEffect(() => {
    guideTargetQuadRef.current = guideQuad;
  });

  return (
    <div className="qr-scanner" data-phase={phase} ref={containerRef}>
      <div className="qr-scanner__camera">
        <video
          ref={videoRef}
          className="qr-scanner__video"
          autoPlay
          playsInline
          muted
        />
        {!cameraReady && <div className="qr-scanner__camera-fallback" />}
      </div>

      {phase !== "A" &&
        phase !== "A2" &&
        phase !== "B" &&
        snapshotUrl &&
        snapshotBox && (
          <img
            className="qr-scanner__snapshot"
            src={snapshotUrl}
            alt=""
            style={{
              left: snapshotBox.left,
              top: snapshotBox.top,
              width: snapshotBox.width,
              height: snapshotBox.height,
            }}
          />
        )}

      <svg
        className="qr-scanner__frame"
        data-hidden={phase === "C"}
        width={containerSize.width}
        height={containerSize.height}
        viewBox={`0 0 ${containerSize.width} ${containerSize.height}`}
      >
        {[0, 1, 2, 3].map((index) => (
          <path
            key={index}
            ref={(el) => {
              guideCornerRefs.current[index] = el;
            }}
            className="qr-scanner__frame-corner"
          />
        ))}
      </svg>

      <div className="qr-scanner__banner" data-visible={bannerVisible}>
        スキャンするコードを見つけてください。
      </div>

      {cameraError && (
        <div className="qr-scanner__camera-warning">
          カメラを利用できません。ブラウザの設定でカメラへのアクセスを許可してください。
        </div>
      )}

      <button
        type="button"
        className="qr-scanner__torch"
        data-active={torchOn}
        onClick={handleTorchToggle}
        aria-pressed={torchOn}
        aria-label="ライトを切り替える"
      >
        <TorchIcon />
      </button>

      <div
        className="qr-scanner__sheet"
        data-open={sheetOpen}
        aria-hidden={!sheetOpen}
      >
        <div className="qr-scanner__sheet-header">
          <TextIcon />
          <span>{resultIsUrl ? "URL" : "テキスト"}</span>
        </div>
        <p className="qr-scanner__sheet-body">{resultText}</p>
        <div className="qr-scanner__sheet-actions">
          <a
            className="qr-scanner__sheet-action"
            href={primaryActionHref}
            target="_blank"
            rel="noreferrer"
            tabIndex={sheetOpen ? 0 : -1}
          >
            {primaryActionLabel}
          </a>
          <button
            type="button"
            className="qr-scanner__sheet-action"
            onClick={handleCopy}
            tabIndex={sheetOpen ? 0 : -1}
          >
            {copyFeedback ? "コピーしました" : "コピー"}
          </button>
        </div>
        <button
          type="button"
          className="qr-scanner__sheet-cancel"
          onClick={reset}
          tabIndex={sheetOpen ? 0 : -1}
        >
          キャンセル
        </button>
      </div>
    </div>
  );
}

function TorchIcon() {
  return (
    <svg viewBox="0 0 24 24" role="presentation" aria-hidden="true">
      <path d="M9 2h6l-1 7h3l-8 13 1-9H7z" fill="currentColor" />
    </svg>
  );
}

function TextIcon() {
  return (
    <svg viewBox="0 0 24 24" role="presentation" aria-hidden="true">
      <path
        d="M4 5h16M4 12h16M4 19h10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default QrScanner;
