import React from "react";
import { Activity, CheckCircle, AlertCircle, Play, Square, Camera, RotateCcw } from "lucide-react";
import { AnalysisResult, SessionStatus } from "../types";

interface FeedbackPanelProps {
  analyzing: boolean;
  result: AnalysisResult | null;
  onAnalyze: () => void;
  onStartSession: () => void;
  onEndSession: () => void;
  sessionStatus: SessionStatus;
  repCount: number;
}

const FeedbackPanel: React.FC<FeedbackPanelProps> = ({ 
  analyzing, 
  result, 
  onAnalyze, 
  onStartSession,
  onEndSession,
  sessionStatus,
  repCount 
}) => {
  return (
    <div className="flex flex-col gap-4 p-6 bg-slate-800/50 backdrop-blur-md border border-slate-700 rounded-2xl h-full shadow-xl">
      <div className="flex justify-between items-center mb-2">
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          <Activity className="w-5 h-5 text-emerald-400" />
          AI Coach
        </h2>
        <div className={`px-3 py-1 rounded-full text-xs font-mono font-bold ${sessionStatus === 'ACTIVE' ? 'bg-emerald-500/20 text-emerald-400 animate-pulse' : 'bg-slate-700 text-slate-300'}`}>
          {sessionStatus === 'ACTIVE' ? 'LIVE TRACKING' : sessionStatus === 'IDLE' ? 'READY' : 'PAUSED'}
        </div>
      </div>

      {/* Main Feedback Display */}
      <div className="flex-grow flex flex-col items-center justify-center text-center space-y-4">
        
        {/* IDLE STATE */}
        {sessionStatus === 'IDLE' && !result && (
          <div className="text-slate-400">
            <div className="w-16 h-16 bg-slate-700 rounded-full flex items-center justify-center mx-auto mb-4">
               <Play className="w-8 h-8 text-white ml-1" />
            </div>
            <p className="mb-2 font-medium text-white">Ready to Squat?</p>
            <p className="text-sm opacity-70">Press Start Set to begin the session.</p>
          </div>
        )}

        {/* ACTIVE STATE */}
        {sessionStatus === 'ACTIVE' && (
          <div className="w-full flex flex-col items-center">
            <div className="text-6xl font-black text-white mb-2 font-mono tracking-tighter">
              {repCount}
            </div>
            <p className="text-emerald-400 font-medium uppercase tracking-widest text-sm">Reps Completed</p>
          </div>
        )}

        {/* LOADING STATE */}
        {analyzing && (
          <div className="flex flex-col items-center animate-pulse">
            <div className="w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-emerald-400 font-medium">Gemini is Thinking...</p>
          </div>
        )}

        {/* GEMINI RESULT CARD */}
        {result && !analyzing && (
          <div className={`w-full text-left p-4 rounded-xl border animate-in fade-in slide-in-from-bottom-4 duration-500 ${result.isGoodForm ? 'bg-emerald-900/20 border-emerald-500/50' : 'bg-red-900/20 border-red-500/50'}`}>
            <div className="flex items-center gap-2 mb-2">
              {result.isGoodForm ? (
                <CheckCircle className="w-6 h-6 text-emerald-400" />
              ) : (
                <AlertCircle className="w-6 h-6 text-red-400" />
              )}
              <h3 className={`font-bold ${result.isGoodForm ? 'text-emerald-400' : 'text-red-400'}`}>
                {result.isGoodForm ? "Good Form" : "Adjustment Needed"}
              </h3>
            </div>
            <p className="text-white text-sm leading-relaxed mb-3">
              {result.feedback}
            </p>
            {result.correction && (
              <div className="mt-2 text-xs font-mono bg-black/30 p-2 rounded text-yellow-200">
                TIP: {result.correction}
              </div>
            )}
          </div>
        )}

        {/* SUMMARY STATE */}
        {sessionStatus === 'SUMMARY' && !result && !analyzing && (
          <div className="text-center">
             <div className="text-4xl font-bold text-white mb-1">{repCount}</div>
             <p className="text-slate-400 text-sm mb-6">Total Reps</p>
             <button 
               onClick={onStartSession}
               className="text-emerald-400 text-sm hover:underline flex items-center justify-center gap-1 mx-auto"
             >
                <RotateCcw className="w-4 h-4" /> Start New Set
             </button>
          </div>
        )}
      </div>

      {/* CONTROLS */}
      <div className="space-y-3">
        {sessionStatus === 'ACTIVE' ? (
          <>
             <button
              onClick={onAnalyze}
              disabled={analyzing}
              className="w-full py-3 rounded-xl font-bold text-sm border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 transition-colors flex items-center justify-center gap-2"
            >
              <Camera className="w-4 h-4" />
              Spot Check (Gemini)
            </button>
            <button
              onClick={onEndSession}
              className="w-full py-4 rounded-xl font-bold text-lg bg-red-500 hover:bg-red-600 text-white shadow-lg transition-all flex items-center justify-center gap-2"
            >
              <Square className="w-5 h-5 fill-current" />
              Finish Set
            </button>
          </>
        ) : (
          sessionStatus !== 'COUNTDOWN' && (
            <button
              onClick={onStartSession}
              disabled={analyzing}
              className="w-full py-4 rounded-xl font-bold text-lg bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-lg shadow-emerald-500/20 hover:shadow-emerald-500/40 transition-all transform active:scale-95 flex items-center justify-center gap-2"
            >
              <Play className="w-5 h-5 fill-current" />
              {sessionStatus === 'SUMMARY' ? 'Start New Set' : 'Start Set'}
            </button>
          )
        )}
      </div>
    </div>
  );
};

export default FeedbackPanel;
