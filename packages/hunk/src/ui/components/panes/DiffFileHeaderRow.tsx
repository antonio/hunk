import { MouseButton } from "@opentui/core";
import type { DiffFile } from "../../../core/changeset/model";
import { fileHeaderStats, fitFileHeaderLabel } from "../../lib/fileHeader";
import { measureTextWidth } from "../../lib/text";
import type { AppTheme } from "../../themes";

interface DiffFileHeaderRowProps {
  file: DiffFile;
  collapsed?: boolean;
  onToggleFileCollapsed?: () => void;
  fileCollapseLabel?: string;
  headerLabelWidth: number;
  headerStatsWidth: number;
  theme: AppTheme;
  onSelect?: () => void;
}

/** Render one file header row in the review stream or sticky overlay. */
export function DiffFileHeaderRow({
  file,
  collapsed = false,
  onToggleFileCollapsed,
  fileCollapseLabel = "Fold diff",
  headerLabelWidth,
  headerStatsWidth,
  theme,
  onSelect,
}: DiffFileHeaderRowProps) {
  const { additionsText, deletionsText } = fileHeaderStats(file);
  const { filename, stateLabel } = fitFileHeaderLabel(
    file,
    Math.max(
      1,
      headerLabelWidth - (onToggleFileCollapsed ? measureTextWidth(fileCollapseLabel) + 5 : 0),
    ),
  );

  return (
    <box
      style={{
        width: "100%",
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
        justifyContent: "space-between",
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: theme.panel,
      }}
      onMouseUp={onSelect}
    >
      {/* Clicking the file header jumps the main stream selection without collapsing to a single-file view. */}
      <box style={{ flexDirection: "row" }}>
        {onToggleFileCollapsed ? (
          <text
            fg={collapsed ? theme.muted : theme.text}
            onMouseUp={(event) => {
              event.stopPropagation();
              if (event.button === MouseButton.LEFT) onToggleFileCollapsed();
            }}
          >
            {`${collapsed ? "[x]" : "[ ]"} ${fileCollapseLabel} `}
          </text>
        ) : null}
        <text fg={theme.text}>{filename}</text>
        {stateLabel && <text fg={theme.muted}>{stateLabel}</text>}
      </box>
      <box
        style={{
          width: headerStatsWidth,
          height: 1,
          flexDirection: "row",
          justifyContent: "flex-end",
        }}
      >
        <text fg={theme.badgeAdded}>{additionsText}</text>
        <text fg={theme.muted}> </text>
        <text fg={theme.badgeRemoved}>{deletionsText}</text>
        <text fg={theme.muted}> </text>
      </box>
    </box>
  );
}
