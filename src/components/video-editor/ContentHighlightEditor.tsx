import { type MutableRefObject, useRef } from "react";
import { Rnd } from "react-rnd";
import type { AnnotationRegion } from "./types";
import type { CursorViewportRect } from "./videoPlayback/cursorViewport";
import { projectHighlightRect, unprojectHighlightRect } from "./videoPlayback/contentHighlights";

const HANDLE_STYLE = {
	width: "12px",
	height: "12px",
	backgroundColor: "white",
	border: "2px solid #2563EB",
	borderRadius: "50%",
} as const;

interface ContentHighlightEditorProps {
	/** Layer whose CSS transform the playback ticker keeps in sync with the camera. */
	layerRef: MutableRefObject<HTMLDivElement | null>;
	highlights: AnnotationRegion[];
	selectedId: string | null | undefined;
	maskRect: CursorViewportRect | null;
	cameraScale: number;
	onSelect?: (id: string) => void;
	onPositionChange?: (id: string, position: { x: number; y: number }) => void;
	onSizeChange?: (id: string, size: { width: number; height: number }) => void;
}

/**
 * Interaction layer for content-anchored highlights in the preview. The shapes
 * themselves are drawn by Pixi inside the camera container; this layer only
 * provides hit targets and resize handles, transformed exactly like the camera
 * so the handles stay glued to the shape while zoomed.
 */
export function ContentHighlightEditor({
	layerRef,
	highlights,
	selectedId,
	maskRect,
	cameraScale,
	onSelect,
	onPositionChange,
	onSizeChange,
}: ContentHighlightEditorProps) {
	const isDraggingRef = useRef(false);
	const scale = cameraScale > 0 ? cameraScale : 1;

	return (
		<div
			ref={layerRef}
			className="absolute inset-0"
			style={{ transformOrigin: "0 0", pointerEvents: "none" }}
		>
			{maskRect
				? highlights.map((annotation) => {
						const rect = projectHighlightRect(annotation, maskRect);
						if (!rect) return null;
						const isSelected = annotation.id === selectedId;
						const commitRect = (next: {
							x: number;
							y: number;
							width: number;
							height: number;
						}) => {
							const source = unprojectHighlightRect(next, maskRect);
							if (!source) return;
							onPositionChange?.(annotation.id, source.position);
							onSizeChange?.(annotation.id, source.size);
						};

						return (
							<Rnd
								key={annotation.id}
								scale={scale}
								position={{ x: rect.x, y: rect.y }}
								size={{ width: rect.width, height: rect.height }}
								enableResizing={isSelected}
								disableDragging={!isSelected}
								onDragStart={() => {
									isDraggingRef.current = true;
								}}
								onDragStop={(_event, data) => {
									commitRect({
										x: data.x,
										y: data.y,
										width: rect.width,
										height: rect.height,
									});
									setTimeout(() => {
										isDraggingRef.current = false;
									}, 100);
								}}
								onResizeStop={(_event, _direction, element, _delta, position) => {
									commitRect({
										x: position.x,
										y: position.y,
										width: element.offsetWidth,
										height: element.offsetHeight,
									});
								}}
								onClick={() => {
									if (isDraggingRef.current) return;
									onSelect?.(annotation.id);
								}}
								className="cursor-move"
								style={{
									zIndex: isSelected
										? annotation.zIndex + 1000
										: annotation.zIndex,
									pointerEvents: "auto",
									outline: isSelected
										? `${2 / scale}px dashed rgba(37, 99, 235, 0.9)`
										: "none",
									outlineOffset: `${4 / scale}px`,
								}}
								resizeHandleStyles={
									isSelected
										? {
												topLeft: {
													...HANDLE_STYLE,
													left: "-6px",
													top: "-6px",
													cursor: "nwse-resize",
													transform: `scale(${1 / scale})`,
												},
												topRight: {
													...HANDLE_STYLE,
													right: "-6px",
													top: "-6px",
													cursor: "nesw-resize",
													transform: `scale(${1 / scale})`,
												},
												bottomLeft: {
													...HANDLE_STYLE,
													left: "-6px",
													bottom: "-6px",
													cursor: "nesw-resize",
													transform: `scale(${1 / scale})`,
												},
												bottomRight: {
													...HANDLE_STYLE,
													right: "-6px",
													bottom: "-6px",
													cursor: "nwse-resize",
													transform: `scale(${1 / scale})`,
												},
											}
										: undefined
								}
							/>
						);
					})
				: null}
		</div>
	);
}
