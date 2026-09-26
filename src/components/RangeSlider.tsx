import { useRef, type InputHTMLAttributes, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  onInteractionChange?: (active: boolean) => void;
}

interface InteractionState {
  pointerId: number | null;
}

export function RangeSlider({ onInteractionChange, onPointerDown, onPointerUp, onPointerCancel, onLostPointerCapture, onMouseDown, ...props }: Props) {
  const interaction = useRef<InteractionState>({ pointerId: null });
  const reportInteraction = () => onInteractionChange?.(interaction.current.pointerId !== null);

  const handlePointerDown = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (event.button === 0) {
      interaction.current.pointerId = event.pointerId;
      reportInteraction();
    }
    event.stopPropagation();
    onPointerDown?.(event);
  };

  const finishPointer = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (interaction.current.pointerId === event.pointerId) interaction.current.pointerId = null;
    reportInteraction();
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLInputElement>) => {
    finishPointer(event);
    onPointerUp?.(event);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLInputElement>) => {
    finishPointer(event);
    onPointerCancel?.(event);
  };

  const handleLostPointerCapture = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (interaction.current.pointerId === event.pointerId) interaction.current.pointerId = null;
    reportInteraction();
    onLostPointerCapture?.(event);
  };

  const handleMouseDown = (event: ReactMouseEvent<HTMLInputElement>) => {
    // The native range control must keep the default mouse interaction. Only
    // prevent the surrounding transparent widget from interpreting the same
    // press as a request to drag the whole window.
    event.stopPropagation();
    onMouseDown?.(event);
  };

  return (
    <input
      {...props}
      type="range"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handleLostPointerCapture}
      onMouseDown={handleMouseDown}
    />
  );
}
