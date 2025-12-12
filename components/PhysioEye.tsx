import React, { useEffect, useRef, forwardRef, useImperativeHandle, useState } from "react";
import { PoseResults, PhysioEyeRef, HUDState } from "../types";
import { 
  drawBiomechanicalSkeleton, 
  drawDepthFloor, 
  drawTorsoLeanCone, 
  drawValgusArrows 
} from "../lib/PoseDrawing";

interface PhysioEyeProps {
  onLandmarksDetected: (results: PoseResults) => void;
  isActive: boolean;
  hudState?: HUDState;
}

const PhysioEye = forwardRef<PhysioEyeRef, PhysioEyeProps>(({ onLandmarksDetected, isActive, hudState }, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const isProcessingRef = useRef<boolean>(false);
  
  // TRICK 1: onLandmarksDetectedRef
  // Keeps the AI running smoothly by avoiding restart on parent state changes.
  const onLandmarksDetectedRef = useRef(onLandmarksDetected);
  useEffect(() => {
    onLandmarksDetectedRef.current = onLandmarksDetected;
  }, [onLandmarksDetected]);

  // TRICK 2: analysisContextRef (The HUD Context)
  // Allows the independent animation loop to read the latest React state for drawing
  // without needing to be in the React render cycle itself.
  const analysisContextRef = useRef<HUDState | undefined>(hudState);
  useEffect(() => {
    analysisContextRef.current = hudState;
  }, [hudState]);

  // Internal state to track if camera is ready
  const [cameraReady, setCameraReady] = useState(false);

  // Helper to draw the HUD overlay (Text Box)
  const drawHUD = (ctx: CanvasRenderingContext2D, state: HUDState) => {
    if (!state.visible) return;

    const padding = 16;
    const boxHeight = 50;
    const text = state.message.toUpperCase();
    
    ctx.save();
    
    // 1. Draw Message Box
    ctx.font = "bold 24px sans-serif";
    const textMetrics = ctx.measureText(text);
    const boxWidth = textMetrics.width + (padding * 3);

    // Draw "Fault Box" background
    ctx.fillStyle = state.color; // Dynamic color (Red/Green)
    ctx.globalAlpha = 0.8;
    // Position: Top-right corner with some margin
    const x = ctx.canvas.width - boxWidth - 20;
    const y = 20;
    
    ctx.beginPath();
    ctx.roundRect(x, y, boxWidth, boxHeight, 12);
    ctx.fill();

    // Draw Text
    ctx.fillStyle = "#FFFFFF";
    ctx.globalAlpha = 1.0;
    ctx.fillText(text, x + padding, y + 34);

    // 2. Draw Tracking Indicator (Top-Left)
    if (state.trackingMode) {
      const indX = 30;
      const indY = 45;
      
      ctx.beginPath();
      ctx.arc(indX, indY, 8, 0, 2 * Math.PI);
      
      if (state.trackingMode === 'OPTIMAL') {
        ctx.fillStyle = '#10B981'; // Green
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#10B981';
      } else if (state.trackingMode === 'DEGRADED') {
        ctx.fillStyle = '#F59E0B'; // Yellow
        ctx.shadowBlur = 0;
      } else if (state.trackingMode === 'ESTIMATED') {
        ctx.fillStyle = '#F97316'; // Orange
        // Pulse effect simulation (based on time)
        const pulse = (Date.now() % 1000) / 1000;
        ctx.globalAlpha = 0.5 + (pulse * 0.5);
      } else {
        ctx.fillStyle = '#EF4444'; // Red (Lost)
      }
      
      ctx.fill();
      ctx.shadowBlur = 0; // reset
      ctx.globalAlpha = 1.0;

      // Label
      ctx.font = "bold 12px monospace";
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(state.trackingMode, indX + 16, indY + 4);
    }
    
    ctx.restore();
  };

  // Expose methods to parent
  useImperativeHandle(ref, () => ({
    getScreenshot: () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!canvas || !video) return null;
      
      // Optimization: Scale down to max 512px for Gemini token/bandwidth savings
      const maxDimension = 512;
      const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
      
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = video.videoWidth * scale;
      tempCanvas.height = video.videoHeight * scale;
      const ctx = tempCanvas.getContext('2d');
      
      if (ctx) {
        // COMPOSITE IMAGE CREATION
        
        // 1. Draw Video Frame (Background)
        // CRITICAL: Mirror the video frame to match the manually-mirrored skeleton on the canvas.
        ctx.save();
        ctx.translate(tempCanvas.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
        ctx.restore();
        
        // 2. Draw Skeleton/HUD Overlay (Foreground)
        // The canvas already contains the mirrored skeleton and normal text.
        ctx.drawImage(canvas, 0, 0, tempCanvas.width, tempCanvas.height);
        
        return tempCanvas.toDataURL('image/jpeg', 0.8);
      }
      return null;
    }
  }));

  useEffect(() => {
    let pose: any = null;
    let isActiveSession = true;

    const initMediaPipe = async () => {
      // Wait for window.Pose to load if not ready
      if (!window.Pose) {
        console.log("Waiting for MediaPipe Pose...");
        setTimeout(initMediaPipe, 100);
        return;
      }

      // 1. Setup Pose
      try {
          pose = new window.Pose({
            locateFile: (file: string) => {
              return `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`;
            },
          });

          pose.setOptions({
            modelComplexity: 1,
            smoothLandmarks: true,
            enableSegmentation: false,
            smoothSegmentation: false,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });

          pose.onResults((results: PoseResults) => {
            const canvas = canvasRef.current;
            const video = videoRef.current;
            if (!canvas || !video) return;

            const ctx = canvas.getContext("2d");
            if (!ctx) return;

            // Sync canvas size to video size
            if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
            }

            ctx.save();
            ctx.clearRect(0, 0, canvas.width, canvas.height); // Clear previous frame

            if (results.poseLandmarks) {
              // 2. NEW: Draw Biomechanical Skeleton with Z-Depth
              // Note: Logic inside PoseDrawing now handles the horizontal flip manually
              drawBiomechanicalSkeleton(ctx, results.poseLandmarks);
              
              // 3. NEW: Draw Visual Guides based on Mechanics State
              if (analysisContextRef.current?.visualContext) {
                 const mechanics = analysisContextRef.current.visualContext;
                 
                 drawDepthFloor(ctx, results.poseLandmarks, mechanics);
                 drawTorsoLeanCone(ctx, results.poseLandmarks, mechanics);
                 drawValgusArrows(ctx, results.poseLandmarks, mechanics);
              }
            }

            // 4. Conditional HUD (Text Box)
            // Drawn last so it's on top. Text is readable because canvas is not CSS-flipped.
            if (analysisContextRef.current) {
              drawHUD(ctx, analysisContextRef.current);
            }

            ctx.restore();

            // 5. Notify Parent via Ref
            if (onLandmarksDetectedRef.current) {
              onLandmarksDetectedRef.current(results);
            }
          });
      } catch (e) {
          console.error("Failed to initialize Pose:", e);
          return;
      }

      // 2. Setup Camera (Manual Method)
      // We rely on getUserMedia directly instead of CameraUtils to avoid timeouts
      try {
        if (!videoRef.current) return;

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { 
              width: { ideal: 640 }, 
              height: { ideal: 480 },
              facingMode: 'user'
          },
          audio: false
        });
        
        streamRef.current = stream;
        
        if (videoRef.current) {
            videoRef.current.srcObject = stream;
            
            // Wait for video to load metadata
            videoRef.current.onloadedmetadata = () => {
                if (videoRef.current) {
                    videoRef.current.play()
                        .then(() => {
                            setCameraReady(true);
                            startProcessingLoop();
                        })
                        .catch(e => console.error("Video play error:", e));
                }
            };
        }
      } catch (err) {
        console.error("Camera Error:", err);
      }
    };

    const startProcessingLoop = () => {
        const loop = async () => {
            if (!isActiveSession) return;
            
            // Only process if video is playing and pose is ready
            if (
                videoRef.current && 
                videoRef.current.readyState >= 2 && 
                pose && 
                !isProcessingRef.current
            ) {
                isProcessingRef.current = true;
                try {
                    await pose.send({ image: videoRef.current });
                } catch (e) {
                    // Ignore transient errors during frame processing
                } finally {
                    isProcessingRef.current = false;
                }
            }
            
            requestRef.current = requestAnimationFrame(loop);
        };
        loop();
    };

    // Start initialization
    initMediaPipe();

    return () => {
      isActiveSession = false;
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      
      // Cleanup Stream
      if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop());
          streamRef.current = null;
      }
      
      if (pose) pose.close();
    };
  }, [isActive]); 

  return (
    <div className="relative w-full h-full rounded-2xl overflow-hidden bg-black shadow-2xl ring-1 ring-white/10">
      {/* Layer 1: Webcam Video (Bottom) - Flipped via CSS for Mirror Effect */}
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover transform -scale-x-100 z-0"
        playsInline
        muted
        // AutoPlay is handled manually in logic now, but keep attribute for safety
        autoPlay
      ></video>

      {/* Layer 2: Canvas Drawings (Top) - NOT FLIPPED via CSS. Drawing logic handles mirroring manually. */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full object-cover z-10" 
      ></canvas>

      {!cameraReady && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-900 text-white animate-pulse z-20">
          <p>Initializing Physio Eye...</p>
        </div>
      )}
    </div>
  );
});

export default PhysioEye;