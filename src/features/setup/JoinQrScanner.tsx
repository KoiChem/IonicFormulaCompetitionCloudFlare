import { useEffect, useRef, useState } from 'react';
import { parseJoinQr, type JoinQrTarget } from './join-qr';

export function JoinQrScanner({ onRead, onClose }: { onRead(target: JoinQrTarget): void; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const opener = document.activeElement as HTMLElement | null;
    const stop = () => { stream?.getTracks().forEach(track => track.stop()); if (timer) clearTimeout(timer); };
    const hide = () => { if (document.hidden) { live = false; stop(); onClose(); } };
    dialog.current?.showModal();
    document.addEventListener('visibilitychange', hide);
    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
        // Ask for camera access directly from opening the scanner; never request audio.
        const camera = navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        stream = await camera;
        if (!live) { stop(); return; }
        const preview = video.current!;
        preview.srcObject = stream;
        await preview.play();
        const { default: jsQR } = await import('jsqr');
        if (!live) { stop(); return; }
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('unsupported');
        setReady(true);
        const scan = () => {
          if (!live) return;
          try {
            if (preview.readyState >= 2 && preview.videoWidth && preview.videoHeight) {
              const scale = Math.min(1, 720 / Math.max(preview.videoWidth, preview.videoHeight));
              canvas.width = Math.round(preview.videoWidth * scale);
              canvas.height = Math.round(preview.videoHeight * scale);
              context.drawImage(preview, 0, 0, canvas.width, canvas.height);
              const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
              const qr = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' });
              if (qr) {
                const target = parseJoinQr(qr.data, location.origin, import.meta.env.BASE_URL);
                if (target) { live = false; stop(); onRead(target); return; }
                setError('このアプリの参加用QRコードを読み取ってください。');
              }
            }
            timer = setTimeout(scan, 180);
          } catch { stop(); setError('読み取りを続けられませんでした。閉じてもう一度お試しください。'); }
        };
        scan();
      } catch (reason) {
        stop();
        if (!live) return;
        const name = (reason as { name?: string }).name;
        setError(name === 'NotAllowedError' || name === 'SecurityError'
          ? 'カメラが許可されていません。ブラウザーの設定で許可するか、参加コードを手入力してください。'
          : name === 'NotFoundError' ? 'カメラが見つかりません。参加コードを手入力してください。'
          : 'カメラを起動できませんでした。ほかのアプリで使用中でないか確認するか、参加コードを手入力してください。');
      }
    };
    void start();
    return () => {
      live = false; stop();
      document.removeEventListener('visibilitychange', hide);
      if (video.current) video.current.srcObject = null;
      if (opener?.isConnected) opener.focus();
    };
  }, [onRead, onClose]);
  return <dialog ref={dialog} className="qr-scanner" aria-labelledby="qr-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <h2 id="qr-title">参加用QRコードを読み取る</h2>
    <p>先生の画面に表示されたQRコードをカメラに映してください。</p>
    <video ref={video} autoPlay muted playsInline aria-label="QR読み取り用カメラ" />
    {!ready && !error && <p role="status">カメラを起動しています…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <button type="button" onClick={onClose} autoFocus>閉じる</button>
  </dialog>;
}
