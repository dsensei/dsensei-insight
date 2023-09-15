import { createSlice, PayloadAction } from "@reduxjs/toolkit";
import { DimensionSliceKey, InsightMetric } from "../common/types";
import { Graph } from "../common/utils";

export const csvHeader = [
  "columns",
  "column_values",
  "base_period_size",
  "comparison_period_size",
  "previous_value",
  "comparison_value",
  "impact",
];

export type RowStatus = {
  key: string[];
  keyComponents: string[];
  isExpanded: boolean;
  hasCalculatedChildren: boolean;
  children: {
    [key: string]: RowStatus;
  };
};

export interface ComparisonInsightState {
  analyzingMetrics: InsightMetric;
  relatedMetrics: InsightMetric[];
  selectedSliceKey?: DimensionSliceKey;
  tableRowStatus: {
    [key: string]: RowStatus;
  };
  tableRowCSV: (number | string)[][];
  tableRowStatusByDimension: {
    [key: string]: {
      rowStatus: {
        [key: string]: RowStatus;
      };
      rowCSV: (number | string)[][];
    };
  };
  waterfallRows: {
    key: DimensionSliceKey;
    impact: number;
  }[];
  isLoading: boolean;
  groupRows: boolean;
  mode: "impact" | "outlier";
  sensitivity: "low" | "medium" | "high";
}

const THRESHOLD = {
  low: 0.075,
  medium: 0.15,
  high: 0.25,
};

function helper(
  row: RowStatus,
  checkingKey: string,
  checkingKeyComponents: string[],
  connectedSegments: string[][],
  segmentToConnectedSegmentsIndex: {
    [key: string]: number;
  },
  maxNumChildren?: number
) {
  const rowKey = row.keyComponents.join("|");
  let rowKeys = [rowKey];
  const connectedSegmentsIndex = segmentToConnectedSegmentsIndex[rowKey];
  if (segmentToConnectedSegmentsIndex[rowKey]) {
    rowKeys = connectedSegments[connectedSegmentsIndex];
  }

  if (
    !rowKeys.find((rowKey) => {
      const rowKeyComponents = rowKey.split("|");
      return rowKeyComponents.every((component) =>
        checkingKeyComponents.includes(component)
      );
    })
  ) {
    return false;
  }

  const newRow = {
    key: [...row.key, checkingKey],
    keyComponents: checkingKeyComponents,
    isExpanded: false,
    children: {},
    hasCalculatedChildren: true,
  };

  let hasMatching = false;
  Object.values(row.children).forEach((child) => {
    if (
      helper(
        child,
        checkingKey,
        checkingKeyComponents,
        connectedSegments,
        segmentToConnectedSegmentsIndex,
        maxNumChildren
      )
    ) {
      hasMatching = true;
    }
  });

  if (
    !hasMatching &&
    (!maxNumChildren || Object.keys(row.children).length < maxNumChildren)
  ) {
    row.children[checkingKey] = newRow;
  }
  return true;
}

function buildWaterfall(metric: InsightMetric): {
  key: DimensionSliceKey;
  impact: number;
}[] {
  return [];
  const topDriverSliceKeys = metric.topDriverSliceKeys;
  const dimensionSliceInfo = metric.dimensionSliceInfo;

  const initialKey = topDriverSliceKeys[0];
  const initialSlice = dimensionSliceInfo[initialKey];
  const result = [
    {
      key: initialSlice.key,
      impact: initialSlice.impact,
    },
  ];

  const excludeKeys = [initialSlice.key];

  const excludeValues: {
    [key: string]: (number | string)[];
  } = {};

  initialSlice.key.forEach((keyPart) => {
    if (!excludeValues[keyPart.dimension]) {
      excludeValues[keyPart.dimension] = [];
    }

    excludeValues[keyPart.dimension].push(keyPart.value);
  });

  topDriverSliceKeys.forEach((key) => {
    const sliceInfo = dimensionSliceInfo[key];

    const shouldAdd = excludeKeys.every((excludeKey) => {
      return (
        excludeKey
          .map((k) => k.dimension)
          .every((d) => sliceInfo.key.map((k) => k.dimension).includes(d)) &&
        excludeKey.find((k) =>
          sliceInfo.key.find(
            (kk) => kk.dimension === k.dimension && kk.value !== k.value
          )
        )
      );
    });

    if (shouldAdd) {
      sliceInfo.key.forEach((keyPart) => {
        if (!excludeValues[keyPart.dimension]) {
          excludeValues[keyPart.dimension] = [];
        }
        excludeValues[keyPart.dimension].push(keyPart.value);
        excludeKeys.push(sliceInfo.key);
      });

      result.push({
        key: sliceInfo.key,
        impact: sliceInfo.impact,
      });
    }
  });

  return result;
}

function buildRowStatusMap(
  metric: InsightMetric,
  groupRows: boolean,
  mode: "impact" | "outlier" = "impact",
  sensitivity: "low" | "medium" | "high" = "medium"
): [
  {
    [key: string]: RowStatus;
  },
  (number | string)[][]
] {
  let result: { [key: string]: RowStatus } = {};
  const resultInCSV: (number | string)[][] = [csvHeader];
  const filteredTopDriverSliceKeys = metric.topDriverSliceKeys;
  let topDriverSliceKeys = filteredTopDriverSliceKeys.filter((key) => {
    const sliceInfo = metric.dimensionSliceInfo[key];

    // Only show the slice if it has a significant impact or is an outlier
    const changeDev = sliceInfo.changeDev;
    return (
      mode === "impact" ||
      (changeDev > THRESHOLD[sensitivity] && sliceInfo.confidence < 0.05)
    );
  });

  const segmentToConnectedSegmentsIndex: {
    [key: string]: number;
  } = {};
  let connectedSegments: string[][] = [];
  if (mode === "outlier") {
    const sortedTopDriverKeys = topDriverSliceKeys.sort((key1, key2) => {
      const keyComponents1 = key1.split("|");
      const keyComponents2 = key2.split("|");

      return keyComponents1.length - keyComponents2.length;
    });

    const connectedSegmentGraph = new Graph();
    sortedTopDriverKeys.forEach((key) => {
      connectedSegmentGraph.addVertex(key);
    });
    sortedTopDriverKeys.forEach((key, idx) => {
      const keyComponents = key.split("|");
      const sliceInfo = metric.dimensionSliceInfo[key];

      for (let i = 0; i < idx; ++i) {
        const checkingKey = sortedTopDriverKeys[i];
        const checkingKeyComponents = checkingKey.split("|");

        if (
          checkingKeyComponents.every((component) =>
            keyComponents.includes(component)
          )
        ) {
          const checkingSliceInfo = metric.dimensionSliceInfo[checkingKey];
          const sliceValue =
            sliceInfo.comparisonValue.sliceCount +
            sliceInfo.baselineValue.sliceCount;
          const checkingSliceValue =
            checkingSliceInfo.comparisonValue.sliceCount +
            checkingSliceInfo.baselineValue.sliceCount;

          if (
            Math.abs((sliceValue - checkingSliceValue) / checkingSliceValue) <
            0.05
          ) {
            connectedSegmentGraph.addEdge(key, checkingKey);
          }
        }
      }
    });

    connectedSegments = connectedSegmentGraph.connectedComponents();

    const segmentToRepresentingSegment: {
      [key: string]: string;
    } = {};

    connectedSegments.forEach((cluster, clusterIdx) => {
      if (cluster.length === 1) {
        return;
      }

      const key = cluster.sort((key1, key2) => {
        const keyComponents1 = key1.split("|");
        const keyComponents2 = key2.split("|");

        return keyComponents2.length - keyComponents1.length;
      })[0];
      cluster.forEach((element) => {
        segmentToRepresentingSegment[element] = key;
        segmentToConnectedSegmentsIndex[key] = clusterIdx;
      });
    });

    [...topDriverSliceKeys].forEach((key, idx) => {
      if (
        segmentToRepresentingSegment[key] &&
        segmentToRepresentingSegment[key] !== key
      ) {
        delete topDriverSliceKeys[idx];
      }
    });

    topDriverSliceKeys = topDriverSliceKeys.filter((key) => key);
  }

  if (!groupRows) {
    topDriverSliceKeys.forEach((key) => {
      result[key] = {
        key: [key],
        keyComponents: key.split("|"),
        isExpanded: false,
        children: {},
        hasCalculatedChildren: true,
      };
    });
  } else {
    topDriverSliceKeys.forEach((key) => {
      const keyComponents = key.split("|");
      let hasMatching = false;

      for (const child of Object.values(result)) {
        if (
          helper(
            child,
            key,
            keyComponents,
            connectedSegments,
            segmentToConnectedSegmentsIndex
          )
        ) {
          hasMatching = true;
        }

        if (hasMatching) {
          break;
        }
      }

      if (!hasMatching) {
        result[key] = {
          key: [key],
          keyComponents: keyComponents,
          isExpanded: false,
          children: {},
          hasCalculatedChildren: true,
        };
      }
    });
  }

  Object.keys(result).forEach((sliceKey) => {
    const sliceInfo = metric.dimensionSliceInfo[sliceKey];
    resultInCSV.push([
      sliceInfo.key.map((keyPart) => keyPart.dimension).join("|"),
      sliceInfo.key.map((keyPart) => keyPart.value).join("|"),
      sliceInfo.baselineValue.sliceSize,
      sliceInfo.comparisonValue.sliceSize,
      sliceInfo.baselineValue.sliceValue,
      sliceInfo.comparisonValue.sliceValue,
      sliceInfo.impact,
    ]);
  });
  return [result, resultInCSV];
}

function buildRowStatusByDimensionMap(metric: InsightMetric): {
  [key: string]: {
    rowStatus: {
      [key: string]: RowStatus;
    };
    rowCSV: (number | string)[][];
  };
} {
  const result: {
    [key: string]: {
      rowStatus: {
        [key: string]: RowStatus;
      };
      rowCSV: (number | string)[][];
    };
  } = {};

  const dimensionSliceInfoSorted = Object.values(
    metric.dimensionSliceInfo
  ).sort((i1, i2) => Math.abs(i2.impact) - Math.abs(i1.impact));

  dimensionSliceInfoSorted.forEach((sliceInfo) => {
    if (sliceInfo.key.length > 1) {
      return;
    }

    const dimension = sliceInfo.key[0].dimension;
    if (!result[dimension]) {
      result[dimension] = {
        rowCSV: [csvHeader],
        rowStatus: {},
      };
    }

    result[dimension].rowStatus[sliceInfo.serializedKey] = {
      key: [sliceInfo.serializedKey],
      keyComponents: sliceInfo.key.map(
        (keyPart) => `${keyPart.dimension}:${keyPart.value}`
      ),
      isExpanded: false,
      children: {},
      hasCalculatedChildren: false,
    };

    result[dimension].rowCSV.push([
      sliceInfo.key.map((keyPart) => keyPart.dimension).join("|"),
      sliceInfo.key.map((keyPart) => keyPart.value).join("|"),
      sliceInfo.baselineValue.sliceSize,
      sliceInfo.comparisonValue.sliceSize,
      sliceInfo.baselineValue.sliceValue,
      sliceInfo.comparisonValue.sliceValue,
      sliceInfo.impact,
    ]);
  });

  return result;
}

const initialState: ComparisonInsightState = {
  analyzingMetrics: {} as InsightMetric,
  relatedMetrics: [],
  tableRowStatus: {},
  tableRowCSV: [],
  tableRowStatusByDimension: {},
  waterfallRows: [],
  isLoading: true,
  groupRows: true,
  mode: "outlier",
  sensitivity: "medium",
};

export const comparisonMetricsSlice = createSlice({
  name: "comparison-insight",
  initialState,
  reducers: {
    setLoadingStatus: (state, action: PayloadAction<boolean>) => {
      state.isLoading = action.payload;
    },
    updateMetrics: (
      state,
      action: PayloadAction<{ [key: string]: object }>
    ) => {
      const keys = Object.keys(action.payload);
      state.analyzingMetrics = action.payload[keys[0]] as InsightMetric;
      state.relatedMetrics = keys
        .map((key, index) => {
          if (index === 0) {
            return undefined;
          }
          return action.payload[key] as InsightMetric;
        })
        .filter((metric) => metric !== undefined) as InsightMetric[];

      [state.tableRowStatus, state.tableRowCSV] = buildRowStatusMap(
        state.analyzingMetrics,
        true,
        state.mode,
        state.sensitivity
      );
      state.tableRowStatusByDimension = buildRowStatusByDimensionMap(
        state.analyzingMetrics
      );
      state.waterfallRows = buildWaterfall(state.analyzingMetrics);
      state.isLoading = false;
    },

    setMode: (state, action: PayloadAction<"impact" | "outlier">) => {
      state.mode = action.payload;
      state.groupRows = true;
      [state.tableRowStatus, state.tableRowCSV] = buildRowStatusMap(
        state.analyzingMetrics,
        true,
        state.mode,
        state.sensitivity
      );
    },
    setSensitivity: (
      state,
      action: PayloadAction<"low" | "medium" | "high">
    ) => {
      state.sensitivity = action.payload;
      [state.tableRowStatus, state.tableRowCSV] = buildRowStatusMap(
        state.analyzingMetrics,
        true,
        state.mode,
        state.sensitivity
      );
    },
    toggleRow: (
      state,
      action: PayloadAction<{
        keyPath: string[];
        dimension?: string;
      }>
    ) => {
      let rowStatus: RowStatus | undefined;
      const { keyPath, dimension } = action.payload;
      keyPath.forEach((key) => {
        if (!rowStatus) {
          if (dimension) {
            rowStatus =
              state.tableRowStatusByDimension[dimension].rowStatus[key];

            if (!rowStatus.hasCalculatedChildren) {
              const dimensionSliceInfo = Object.values(
                state.analyzingMetrics.dimensionSliceInfo
              ).filter((sliceInfo) =>
                sliceInfo.key.find((k) => k.dimension === dimension)
              );
              // .sort((i1, i2) => Math.abs(i2.impact) - Math.abs(i1.impact));

              dimensionSliceInfo.forEach((sliceInfo) => {
                if (sliceInfo.key.length === 1) {
                  return;
                }

                const keyComponents = sliceInfo.key.map(
                  (keyPart) => `${keyPart.dimension}:${keyPart.value}`
                );
                helper(
                  rowStatus!,
                  sliceInfo.serializedKey,
                  keyComponents,
                  [],
                  {},
                  10
                );

                rowStatus!.hasCalculatedChildren = true;
              });
            }
          } else {
            rowStatus = state.tableRowStatus[key];
          }
        } else {
          rowStatus = rowStatus.children[key];
        }
      });

      if (rowStatus) {
        rowStatus.isExpanded = !rowStatus.isExpanded;
      }
    },
    selectSliceForDetail: (state, action: PayloadAction<DimensionSliceKey>) => {
      state.selectedSliceKey = action.payload;
    },
    toggleGroupRows: (state, action: PayloadAction<void>) => {
      state.groupRows = !state.groupRows;
      [state.tableRowStatus, state.tableRowCSV] = buildRowStatusMap(
        state.analyzingMetrics,
        state.groupRows,
        state.mode,
        state.sensitivity
      );
    },
  },
});

export const {
  toggleRow,
  selectSliceForDetail,
  updateMetrics,
  setLoadingStatus,
  toggleGroupRows,
  setMode,
  setSensitivity,
} = comparisonMetricsSlice.actions;

export default comparisonMetricsSlice.reducer;
