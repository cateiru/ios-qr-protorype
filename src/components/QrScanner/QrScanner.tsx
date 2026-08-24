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

// 中心座標+サイズ+回転角(ラジアン)で表す、傾き追従可能な矩形。
// jsQR は検出したコードの4隅の座標(パース変形込み)を返すため、
// 軸並行のバウンディングボックスではなく回転矩形で扱うことで、
// コードが傾いているときにガイド枠・固定画像がズレないようにする。
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

// スキャンガイド枠(L3)を検出QRコードの矩形から重心を保ったまま広げる倍率。
const GUIDE_PADDING_SCALE = 1.1;

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

// 検出した4隅(台形になりうる)から、回転を反映した矩形(中心・サイズ・角度)を求める。
// 上辺・下辺それぞれの長さ・角度を平均することで、多少のパース歪みがあっても
// 破綻しにくいようにしている(完全な台形変形までは追従しない簡略版)。
function quadToFrame(quad: Quad): Frame {
  const { tl, tr, bl, br } = quad;
  const topVec = { x: tr.x - tl.x, y: tr.y - tl.y };
  const bottomVec = { x: br.x - bl.x, y: br.y - bl.y };
  const leftVec = { x: bl.x - tl.x, y: bl.y - tl.y };
  const rightVec = { x: br.x - tr.x, y: br.y - tr.y };

  const width =
    (Math.hypot(topVec.x, topVec.y) + Math.hypot(bottomVec.x, bottomVec.y)) / 2;
  const height =
    (Math.hypot(leftVec.x, leftVec.y) + Math.hypot(rightVec.x, rightVec.y)) / 2;
  const angle = Math.atan2(topVec.y + bottomVec.y, topVec.x + bottomVec.x);
  const centerX = (tl.x + tr.x + bl.x + br.x) / 4;
  const centerY = (tl.y + tr.y + bl.y + br.y) / 4;

  return { centerX, centerY, width, height, angle };
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
  const [detectedFrame, setDetectedFrame] = useState<Frame | null>(null);
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
  const detectedFrameRef = useRef<Frame | null>(null);
  // captureSnapshot 用に、Frame(回転矩形)に丸める前の生の4隅座標も保持する。
  // ガイド枠(L3)は Frame で近似したままでよいが、固定画像(L2)は本物の
  // 台形(パース)歪みに沿わせたいため、丸められていない座標が必要。
  const detectedQuadRef = useRef<Quad | null>(null);
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

  const reset = () => {
    setPhase("A");
    setCopyFeedback(false);
    setDetectedFrame(null);
    setResultText("");
    setSnapshotUrl(null);
    setSnapshotBox(null);
    detectedFrameRef.current = null;
    detectedQuadRef.current = null;
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
        setDetectedFrame(null);
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
      const frame = quadToFrame(quad);
      detectedFrameRef.current = frame;
      setDetectedFrame(frame);
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
  // タイトな範囲なので、これ以上縮小せずそのまま使う(縮小すると枠がコードに食い込む)
  const idleFrame = scaleFrame(FULL_FRAME, stageScale);
  const paddedDetectedFrame: Frame | null = detectedFrame
    ? {
        ...detectedFrame,
        width: detectedFrame.width * GUIDE_PADDING_SCALE,
        height: detectedFrame.height * GUIDE_PADDING_SCALE,
      }
    : null;
  const frame: Frame =
    phase === "A" || phase === "A2"
      ? idleFrame
      : (paddedDetectedFrame ?? idleFrame);
  const frameTransform = `translate(-50%, -50%) rotate(${frame.angle}rad)`;

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

      <div
        className="qr-scanner__frame"
        data-hidden={phase === "C"}
        style={{
          left: frame.centerX,
          top: frame.centerY,
          width: frame.width,
          height: frame.height,
          transform: frameTransform,
        }}
      >
        <span className="corner corner--tl" />
        <span className="corner corner--tr" />
        <span className="corner corner--bl" />
        <span className="corner corner--br" />
      </div>

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
