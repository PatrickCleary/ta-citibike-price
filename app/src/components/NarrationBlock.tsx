import type { ReactNode } from "react";

// Floating white caption card. Reusable with any content.
export default function NarrationBlock({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none max-w-2xl rounded-xl bg-white/85 px-6 py-4 text-center shadow-lg backdrop-blur">
      {children}
    </div>
  );
}
