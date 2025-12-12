
import React, { useState, useRef, useCallback } from "react";
import PhysioEye from "./components/PhysioEye";
import FeedbackPanel from "./components/FeedbackPanel";
import { analyzeFormWithGemini } from "./services/geminiService";
import { PoseResults, PhysioEyeRef, AnalysisResult, HUDState, SessionStatus } from "./types";
import { POSE_LANDMARKS } from "./utils/geometry";
import { areLandmarksVisible } from "./utils/signal";
import { SquatMechanics, ExerciseState } from "./utils/exerciseLogic";
import { Dumbbell } from "lucide-react";

export default function App() {
  // --- STATE ---
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('IDLE');
  const [countdown, setCountdown] = useState<number>(0);
  
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [repCount, setRepCount] = useState(0);
  
  // Real-time HUD State (passed to MediaPipe loop)
  const [hudState, setHudState] = useState<HUDState>({ message: "", color: "", visible: false });
  
  // --- REFS ---
  const eyeRef = useRef<PhysioEyeRef>(null);
  const squatEngine = useRef(new SquatMechanics());
  
  // TELEMETRY BUFFER: Stores the last ~10 seconds of mechanics state
  const historyRef = useRef<ExerciseState[]>([]);
  
  // PRIORITY LOCK: Prevents real-time engine from overwriting Gemini feedback for N milliseconds.
  // If Date.now() < hudLockRef.current, the engine cannot write to the HUD.
  const hudLockRef = useRef<number>(0);

  // --- ACTIONS ---

  const handleStartSession = () => {
    setSessionStatus('COUNTDOWN');
    setCountdown(3);
    setAnalysisResult(null);
    setRepCount(0);
    squatEngine.current.reset();
    historyRef.current = []; // Clear history

    // 3... 2... 1... GO
    let count = 3;
    const interval = setInterval(() => {
      count--;
      if (count > 0) {
        setCountdown(count);
      } else {
        clearInterval(interval);
        setSessionStatus('ACTIVE');
        setHudState({ message: "GO!", color: "#10B981", visible: true });
      }
    }, 1000);
  };

  const handleEndSession = () => {
    setSessionStatus('SUMMARY');
    setHudState({ message: "SET COMPLETE", color: "#3B82F6", visible: true });
    // Keep the HUD message for a moment
    hudLockRef.current = Date.now() + 3000;
  };

  // Helper to condense history into a context string for Gemini
  const getTelemetrySummary = (history: ExerciseState[]): string => {
    if (history.length === 0) return "No telemetry data available.";

    const minAngle = Math.min(...history.map(s => s.angle));
    // Filter out generic feedback to find specific faults
    const faults = new Set(
      history
        .map(s => s.feedback)
        .filter(f => f !== "GO LOWER" && f !== "DRIVE UP" && f !== "STAND TALL" && f !== "GOOD DEPTH!" && f !== "PERFECT REP!" && f !== "SHOW FULL BODY")
    );
    
    const faultString = faults.size > 0 ? Array.from(faults).join(", ") : "None";
    
    return `Exercise: Squat.
    Telemetry Data (Last 5-10s):
    - Lowest Knee Angle Observed: ${Math.round(minAngle)} degrees (90 is parallel).
    - Detected Tracking Faults: ${faultString}.
    - Movement Phase history captured.`;
  };

  // --- GEMINI TRIGGER ---
  // Memoized so it can be called from handleLandmarks without causing loop issues
  const triggerAnalysis = useCallback(async (customContext?: string) => {
    if (analyzing || !eyeRef.current) return;
    setAnalyzing(true);
    
    // Lock HUD immediately to show "Analyzing..." without flicker
    hudLockRef.current = Date.now() + 10000; // Temporary long lock until fail/success
    setHudState({ message: "AI ANALYZING...", color: "#3B82F6", visible: true });

    try {
      const screenshot = eyeRef.current.getScreenshot();
      
      if (screenshot) {
        // combine user context (if any) with telemetry
        // Enforce "Squat" context to prevent Gemini hallucinating Push-ups due to "PUSH UP" text or ambiguous posture.
        const finalContext = `Exercise: Squat. ${customContext || "User requested spot check."}`;
        
        const result = await analyzeFormWithGemini(screenshot, finalContext);
        setAnalysisResult(result);
        
        // RESULT RECEIVED: Update HUD and Lock it for 4 seconds so user can read it.
        setHudState({ 
            message: result.isGoodForm ? "AI: GOOD FORM" : "AI: IMPROVE", 
            color: result.isGoodForm ? "#10B981" : "#EF4444", 
            visible: true 
        });
        hudLockRef.current = Date.now() + 4000;
        
      }
    } catch (e) {
      console.error(e);
      setHudState({ message: "ERROR", color: "#EF4444", visible: true });
      hudLockRef.current = Date.now() + 2000;
    } finally {
      setAnalyzing(false);
    }
  }, [analyzing]);

  // --- MEDIAPIPE CALLBACK (Runs 30fps) ---
  const handleLandmarks = useCallback((results: PoseResults) => {
    const isLocked = Date.now() < hudLockRef.current;
    
    // 1. Basic Safety Check
    if (!results.poseLandmarks || results.poseLandmarks.length === 0) {
      if (!isLocked) setHudState(prev => ({ ...prev, visible: false }));
      return;
    }

    const landmarks = results.poseLandmarks;
    
    // 2. LOGIC (Only run engine if Active)
    if (sessionStatus === 'ACTIVE') {
      const engineState = squatEngine.current.update(landmarks);
      setRepCount(engineState.repCount);

      // --- TELEMETRY ---
      // Push state to history buffer (only if tracking isn't completely lost)
      if (engineState.trackingMode !== 'LOST') {
        historyRef.current.push(engineState);
        // Keep last 300 frames (~10 seconds at 30fps)
        if (historyRef.current.length > 300) {
            historyRef.current.shift();
        }
      }

      // --- AUTOMATION ---
      // Trigger Gemini automatically every 5 reps
      if (engineState.didFinishRep && engineState.repCount > 0 && engineState.repCount % 5 === 0) {
         const context = getTelemetrySummary(historyRef.current);
         // Call without awaiting to not block loop
         triggerAnalysis(`Auto-Triggered Check (Rep ${engineState.repCount}). ${context}`);
      }
      
      // Update HUD if not locked
      if (!isLocked) {
        setHudState({
            message: `${engineState.feedback} ${engineState.trackingMode !== 'LOST' ? `(${Math.round(engineState.angle)}°)` : ''}`,
            color: engineState.feedbackColor,
            visible: true,
            trackingMode: engineState.trackingMode,
            visualContext: engineState.visualContext // Pass visual context for drawing
        });
      }
    } else if (sessionStatus === 'IDLE') {
       // Just visual feedback in Idle
       if (!isLocked) {
          setHudState({ message: "READY", color: "#64748B", visible: true });
       }
    }

  }, [sessionStatus, triggerAnalysis]); 

  return (
    <div className="min-h-screen bg-slate-900 text-slate-50 font-sans selection:bg-emerald-500/30">
      
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-slate-900/80 backdrop-blur-md border-b border-white/5">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center">
              <Dumbbell className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-xl tracking-tight">PhysioAI<span className="text-emerald-400">.Spotter</span></span>
          </div>
          <div className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
            <span className="hover:text-emerald-400 cursor-pointer transition-colors">History</span>
            <span className="hover:text-emerald-400 cursor-pointer transition-colors">Settings</span>
            <div className="w-8 h-8 rounded-full bg-slate-700 border border-slate-600"></div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="pt-24 pb-8 px-4 max-w-7xl mx-auto h-[calc(100vh)] flex flex-col md:flex-row gap-6">
        
        {/* Left Column: Visual Eye */}
        <div className="flex-1 relative flex flex-col min-h-[400px]">
          <div className="absolute -top-6 left-0 text-xs font-mono text-emerald-500/70 uppercase tracking-widest mb-2 flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${sessionStatus === 'ACTIVE' ? 'bg-red-500 animate-pulse' : 'bg-slate-500'}`}></span>
            {sessionStatus === 'ACTIVE' ? 'LIVE SESSION RECORDING' : 'CAMERA READY'}
          </div>
          
          <PhysioEye 
            ref={eyeRef} 
            isActive={true} 
            onLandmarksDetected={handleLandmarks}
            hudState={hudState}
          />

          {/* COUNTDOWN OVERLAY */}
          {sessionStatus === 'COUNTDOWN' && (
             <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[2px] z-40 pointer-events-none">
                <div className="text-9xl font-black text-white animate-ping">
                  {countdown}
                </div>
             </div>
          )}
          
          {/* Status Overlay */}
          <div className="absolute bottom-4 left-4 right-4 flex justify-between items-end pointer-events-none z-30">
             <div className="bg-black/60 backdrop-blur-sm px-3 py-1.5 rounded-lg border border-white/10 text-xs font-mono text-emerald-400">
               FPS: 30 • LATENCY: LOW
             </div>
          </div>
        </div>

        {/* Right Column: Feedback & Control */}
        <div className="w-full md:w-96 flex-shrink-0 flex flex-col h-auto md:h-full">
          <FeedbackPanel 
            analyzing={analyzing} 
            result={analysisResult} 
            onAnalyze={() => triggerAnalysis()} 
            onStartSession={handleStartSession}
            onEndSession={handleEndSession}
            sessionStatus={sessionStatus}
            repCount={repCount}
          />
          
          <div className="mt-4 p-4 bg-slate-800/30 rounded-xl border border-white/5 text-xs text-slate-500">
            <p className="font-semibold text-slate-400 mb-1">How it works:</p>
            <ol className="list-decimal pl-4 space-y-1">
              <li>Press "Start Set" to begin.</li>
              <li>Wait for the 3s countdown.</li>
              <li>Perform reps. AI counts automatically.</li>
              <li>AI Auto-Spots every 5 reps.</li>
            </ol>
          </div>
        </div>

      </main>
    </div>
  );
}
