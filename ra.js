import "dotenv/config";
import { MongoClient } from "mongodb";
import OpenAI from "openai";
import { createHash } from "node:crypto";

const originalLog = console.log;
const originalError = console.error;

const BLUE = "\x1b[34m";
const RESET = "\x1b[0m";

console.log = (...args) => {
  originalLog(`${BLUE}[RISK-ANALYSIS-SERVICE]${RESET}`, ...args);
};

console.error = (...args) => {
  originalError(`${BLUE}[RISK-ANALYSIS-SERVICE]${RESET}`, ...args);
};

const {
  MONGODB_URI = "mongodb+srv://ms555app_db_user:l5MztOUjHXml6KKI@c0.uoosfng.mongodb.net/",
  MONGODB_DB_NAME = "retail_inventory_db",
  OPENAI_API_KEY = "sk-3LbSGW4wgha8lsD8OUR5fBnhi2nnU6TDIrA2Tu4oN64mDEUZ",

  ENDPOINT = "aiplatform.googleapis.com",
  REGION = "global",
  PROJECT_ID = "p000-513919",
  ACCESS_TOKEN = "",
} = process.env;

const mongoDbClient = new MongoClient(MONGODB_URI);
const openai = new OpenAI({
  baseURL: "https://api.opentyphoon.ai/v1",
  apiKey: OPENAI_API_KEY,
});

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

const PROMOTION_WINDOW_DAYS = 10;
const RECENT_SALES_DAYS = 30;
const PREVIOUS_YEAR_WINDOW_DAYS = 10;

function getStartOfDay(date) {
  const result = new Date(date);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

function getEndOfDay(date) {
  const result = new Date(date);
  result.setUTCHours(23, 59, 59, 999);
  return result;
}

function subtractDays(date, days) {
  return new Date(date.getTime() - days * DAY_IN_MILLISECONDS);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_IN_MILLISECONDS);
}

function subtractYears(date, years) {
  const result = new Date(date);
  result.setUTCFullYear(result.getUTCFullYear() - years);
  return result;
}

// Deterministic, explainable 0-100 scoring. Tune weights and thresholds using real outcomes.
const RISK_WEIGHTS = Object.freeze({
  days_left: 0.3,
  replenishment: 0.25,
  sales_trend: 0.15,
  promotion: 0.1,
  promotion_calendar: 0.1,
  historical_sales: 0.1,
});
const clamp = (value, min = 0, max = 100) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
const avg = (values) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
const riskLevel = (score) =>
  score >= 70 ? "high" : score >= 40 ? "medium" : "low";

function calculateRiskScores(product) {
  const stock = Math.max(0, Number(product.inventory?.current_stock) || 0);
  const velocity = Math.max(
    0,
    Number(product.sales?.sales_velocity_sales_per_day) || 0,
  );
  const recent = product.sales?.recent_sales_30_days || [];
  const daily = new Map(
    recent.map((r) => [r.date, Math.max(0, Number(r.quantity) || 0)]),
  );
  // Missing days count as zero sales; periods use the last 30 UTC calendar days.
  const today = getStartOfDay(new Date());
  const quantities = Array.from({ length: 30 }, (_, i) => {
    const date = addDays(today, i - 29)
      .toISOString()
      .slice(0, 10);
    return daily.get(date) || 0;
  });
  const recent7 = avg(quantities.slice(-7));
  const previous23 = avg(quantities.slice(0, 23));
  const trendGrowth = previous23 > 0 ? (recent7 - previous23) / previous23 : 0;
  const daysCover = velocity > 0 ? stock / velocity : null;
  const daysLeft = velocity === 0 ? 0 : clamp(((14 - daysCover) / 14) * 100);

  const replenishments = product.upcoming_replenishments || [];
  const next = replenishments[0];
  const arrivalDays = next
    ? Math.max(0, Number(next.days_until_arrival) || 0)
    : null;
  const incoming = next ? Math.max(0, Number(next.quantity) || 0) : 0;
  // No replenishment is urgent only when stock cover is short.
  const gap =
    velocity > 0 && arrivalDays !== null
      ? Math.max(0, arrivalDays - (daysCover ?? 0))
      : 0;
  const replenishment =
    velocity === 0
      ? 0
      : arrivalDays === null
        ? clamp(((14 - (daysCover ?? 0)) / 14) * 100)
        : clamp((gap / 7) * 80 + (incoming < velocity * 3 ? 20 : 0));
  const salesTrend = clamp(trendGrowth * 100); // 100% growth -> score 100

  const active = (product.current_promotions || []).length > 0;
  const past = product.past_promotions || [];
  const uplifts = past
    .map((p) => {
      const before = Number(p.sales_window?.average_sales_before) || 0;
      const during = Number(p.sales_window?.average_sales_during) || 0;
      return before > 0 ? (during - before) / before : null;
    })
    .filter((x) => x !== null);
  const uplift = uplifts.length ? Math.max(0, avg(uplifts)) : 0;
  const promotion = active ? clamp(30 + uplift * 70) : 0;
  const promotionCalendar = active && uplifts.length ? clamp(uplift * 100) : 0;

  const historical = product.sales_previous_years_around_same_date || [];
  const historicalDaily =
    historical.reduce((sum, r) => sum + (Number(r.sales_quantity) || 0), 0) /
    21;
  const historicalSales =
    velocity > 0 ? clamp((historicalDaily / velocity - 1) * 100) : 0;

  const factors = {
    days_left: daysLeft,
    replenishment,
    sales_trend: salesTrend,
    promotion,
    promotion_calendar: promotionCalendar,
    historical_sales: historicalSales,
  };
  const score = Object.entries(RISK_WEIGHTS).reduce(
    (total, [key, weight]) => total + factors[key] * weight,
    0,
  );
  return {
    risk_score: Number(score.toFixed(2)),
    overall_risk: riskLevel(score),
    factor_scores: Object.fromEntries(
      Object.entries(factors).map(([key, value]) => [
        key,
        Number(value.toFixed(2)),
      ]),
    ),
    scoring_metrics: {
      stock,
      sales_velocity: velocity,
      days_of_cover: daysCover === null ? null : Number(daysCover.toFixed(2)),
      days_until_next_replenishment: arrivalDays,
      recent_7_day_average: Number(recent7.toFixed(2)),
      previous_23_day_average: Number(previous23.toFixed(2)),
      historical_daily_average: Number(historicalDaily.toFixed(2)),
    },
    scoring_version: "1.0",
  };
}

async function aggregateProducts() {
  try {
    await mongoDbClient.connect();

    console.log("Connected to MongoDB");

    const db = mongoDbClient.db(MONGODB_DB_NAME);
    const productsCollection = db.collection("products");

    const now = new Date();
    const todayStart = getStartOfDay(now);
    const todayEnd = getEndOfDay(now);

    const recentSalesStartDate = getStartOfDay(
      subtractDays(todayStart, RECENT_SALES_DAYS - 1),
    );

    const previousYearSameDate = subtractYears(todayStart, 1);

    const previousYearStartDate = getStartOfDay(
      subtractDays(previousYearSameDate, PREVIOUS_YEAR_WINDOW_DAYS),
    );

    const previousYearEndDate = getEndOfDay(
      addDays(previousYearSameDate, PREVIOUS_YEAR_WINDOW_DAYS),
    );

    const pipeline = [
      {
        $match: {
          status: "active",
        },
      },

      /*
       * 1. Calculate current stock from inventory transactions.
       *
       * type = add       => increase stock
       * type = subtract  => decrease stock
       */
      {
        $lookup: {
          from: "inventory",
          let: {
            productObjectId: "$_id",
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ["$product_id", "$$productObjectId"],
                },
              },
            },
            {
              $group: {
                _id: null,
                current_stock: {
                  $sum: {
                    $switch: {
                      branches: [
                        {
                          case: {
                            $eq: ["$type", "add"],
                          },
                          then: {
                            $ifNull: ["$quantity", 0],
                          },
                        },
                        {
                          case: {
                            $eq: ["$type", "subtract"],
                          },
                          then: {
                            $multiply: [
                              {
                                $ifNull: ["$quantity", 0],
                              },
                              -1,
                            ],
                          },
                        },
                      ],
                      default: 0,
                    },
                  },
                },
              },
            },
          ],
          as: "inventory_summary",
        },
      },

      /*
       * 2. Find upcoming replenishments.
       */
      {
        $lookup: {
          from: "replenishments",
          let: {
            productObjectId: "$_id",
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    {
                      $eq: ["$product_id", "$$productObjectId"],
                    },
                    {
                      $gte: ["$time", todayStart],
                    },
                  ],
                },
              },
            },
            {
              $sort: {
                time: 1,
              },
            },
            {
              $project: {
                _id: 0,
                quantity: {
                  $ifNull: ["$quantity", 0],
                },
                expected_date: {
                  $dateToString: {
                    date: "$time",
                    format: "%Y-%m-%d",
                  },
                },
                days_until_arrival: {
                  $max: [
                    0,
                    {
                      $ceil: {
                        $divide: [
                          {
                            $subtract: ["$time", todayStart],
                          },
                          DAY_IN_MILLISECONDS,
                        ],
                      },
                    },
                  ],
                },
              },
            },
          ],
          as: "upcoming_replenishments",
        },
      },

      /*
       * 3. Find promotions that are currently active according
       * to their date range.
       */
      {
        $lookup: {
          from: "promotions",
          let: {
            productObjectId: "$_id",
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    {
                      $eq: ["$product_id", "$$productObjectId"],
                    },
                    {
                      $lte: ["$start_date", todayEnd],
                    },
                    {
                      $gte: ["$end_date", todayStart],
                    },
                  ],
                },
              },
            },
            {
              $sort: {
                start_date: 1,
              },
            },
            {
              $project: {
                _id: 0,
                active: {
                  $literal: true,
                },
                promotion_id: {
                  $ifNull: ["$promo_code", { $toString: "$_id" }],
                },
                start_date: {
                  $dateToString: {
                    date: "$start_date",
                    format: "%Y-%m-%d",
                  },
                },
                end_date: {
                  $dateToString: {
                    date: "$end_date",
                    format: "%Y-%m-%d",
                  },
                },
              },
            },
          ],
          as: "current_promotions",
        },
      },

      /*
       * 4. Find completed promotions and calculate:
       *
       * average sales for 10 days before
       * average sales during promotion
       * average sales for 10 days after
       */
      {
        $lookup: {
          from: "promotions",
          let: {
            productObjectId: "$_id",
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    {
                      $eq: ["$product_id", "$$productObjectId"],
                    },
                    {
                      $lt: ["$end_date", todayStart],
                    },
                  ],
                },
              },
            },
            {
              $sort: {
                end_date: -1,
              },
            },

            /*
             * Change or remove this limit if all historical
             * promotions are required.
             */
            {
              $limit: 10,
            },
            {
              $lookup: {
                from: "sales",
                let: {
                  salesProductId: "$product_id",
                  promotionStartDate: "$start_date",
                  promotionEndDate: "$end_date",
                  salesWindowStart: {
                    $dateSubtract: {
                      startDate: "$start_date",
                      unit: "day",
                      amount: PROMOTION_WINDOW_DAYS,
                    },
                  },
                  salesWindowEnd: {
                    $dateAdd: {
                      startDate: "$end_date",
                      unit: "day",
                      amount: PROMOTION_WINDOW_DAYS,
                    },
                  },
                },
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $and: [
                          {
                            $eq: ["$product_id", "$$salesProductId"],
                          },
                          {
                            $gte: ["$created_at", "$$salesWindowStart"],
                          },
                          {
                            $lte: ["$created_at", "$$salesWindowEnd"],
                          },
                        ],
                      },
                    },
                  },
                  {
                    $group: {
                      _id: null,

                      total_sales_before: {
                        $sum: {
                          $cond: [
                            {
                              $lt: ["$created_at", "$$promotionStartDate"],
                            },
                            {
                              $ifNull: ["$quantity", 0],
                            },
                            0,
                          ],
                        },
                      },

                      total_sales_during: {
                        $sum: {
                          $cond: [
                            {
                              $and: [
                                {
                                  $gte: ["$created_at", "$$promotionStartDate"],
                                },
                                {
                                  $lte: ["$created_at", "$$promotionEndDate"],
                                },
                              ],
                            },
                            {
                              $ifNull: ["$quantity", 0],
                            },
                            0,
                          ],
                        },
                      },

                      total_sales_after: {
                        $sum: {
                          $cond: [
                            {
                              $gt: ["$created_at", "$$promotionEndDate"],
                            },
                            {
                              $ifNull: ["$quantity", 0],
                            },
                            0,
                          ],
                        },
                      },
                    },
                  },
                ],
                as: "promotion_sales_summary",
              },
            },
            {
              $set: {
                promotion_sales_summary: {
                  $ifNull: [
                    {
                      $arrayElemAt: ["$promotion_sales_summary", 0],
                    },
                    {
                      total_sales_before: 0,
                      total_sales_during: 0,
                      total_sales_after: 0,
                    },
                  ],
                },

                promotion_duration_days: {
                  $add: [
                    {
                      $dateDiff: {
                        startDate: "$start_date",
                        endDate: "$end_date",
                        unit: "day",
                      },
                    },
                    1,
                  ],
                },
              },
            },
            {
              $project: {
                _id: 0,

                promotion_id: {
                  $ifNull: [
                    "$promo_code",
                    {
                      $toString: "$_id",
                    },
                  ],
                },

                start_date: {
                  $dateToString: {
                    date: "$start_date",
                    format: "%Y-%m-%d",
                  },
                },

                end_date: {
                  $dateToString: {
                    date: "$end_date",
                    format: "%Y-%m-%d",
                  },
                },

                sales_window: {
                  days_before: {
                    $literal: PROMOTION_WINDOW_DAYS,
                  },

                  days_after: {
                    $literal: PROMOTION_WINDOW_DAYS,
                  },

                  average_sales_before: {
                    $round: [
                      {
                        $divide: [
                          "$promotion_sales_summary.total_sales_before",
                          PROMOTION_WINDOW_DAYS,
                        ],
                      },
                      2,
                    ],
                  },

                  average_sales_during: {
                    $round: [
                      {
                        $divide: [
                          "$promotion_sales_summary.total_sales_during",
                          {
                            $max: [1, "$promotion_duration_days"],
                          },
                        ],
                      },
                      2,
                    ],
                  },

                  average_sales_after: {
                    $round: [
                      {
                        $divide: [
                          "$promotion_sales_summary.total_sales_after",
                          PROMOTION_WINDOW_DAYS,
                        ],
                      },
                      2,
                    ],
                  },
                },
              },
            },
          ],
          as: "past_promotions",
        },
      },

      /*
       * 5. Aggregate sales for the last 30 calendar days.
       */
      {
        $lookup: {
          from: "sales",
          let: {
            productObjectId: "$_id",
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    {
                      $eq: ["$product_id", "$$productObjectId"],
                    },
                    {
                      $gte: ["$created_at", recentSalesStartDate],
                    },
                    {
                      $lte: ["$created_at", todayEnd],
                    },
                  ],
                },
              },
            },
            {
              $group: {
                _id: {
                  $dateToString: {
                    date: "$created_at",
                    format: "%Y-%m-%d",
                  },
                },
                quantity: {
                  $sum: {
                    $ifNull: ["$quantity", 0],
                  },
                },
              },
            },
            {
              $sort: {
                _id: 1,
              },
            },
            {
              $project: {
                _id: 0,
                date: "$_id",
                quantity: 1,
              },
            },
          ],
          as: "recent_sales_30_days",
        },
      },

      /*
       * 6. Find sales around the same date in the previous year.
       *
       * The event is obtained from promo_code when the sale was
       * associated with a promotion.
       */
      {
        $lookup: {
          from: "sales",
          let: {
            productObjectId: "$_id",
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    {
                      $eq: ["$product_id", "$$productObjectId"],
                    },
                    {
                      $gte: ["$created_at", previousYearStartDate],
                    },
                    {
                      $lte: ["$created_at", previousYearEndDate],
                    },
                  ],
                },
              },
            },
            {
              $group: {
                _id: {
                  date: {
                    $dateToString: {
                      date: "$created_at",
                      format: "%Y-%m-%d",
                    },
                  },
                  promo_code: "$promo_code",
                },
                sales_quantity: {
                  $sum: {
                    $ifNull: ["$quantity", 0],
                  },
                },
              },
            },
            {
              $sort: {
                "_id.date": 1,
              },
            },
            {
              $project: {
                _id: 0,
                date: "$_id.date",
                event: {
                  $cond: [
                    {
                      $and: [
                        {
                          $ne: ["$_id.promo_code", null],
                        },
                        {
                          $ne: ["$_id.promo_code", ""],
                        },
                      ],
                    },
                    "$_id.promo_code",
                    "Regular Sales",
                  ],
                },
                sales_quantity: 1,
              },
            },
          ],
          as: "sales_previous_years_around_same_date",
        },
      },

      /*
       * Calculate values required for the final response.
       */
      {
        $set: {
          current_stock: {
            $ifNull: [
              {
                $arrayElemAt: ["$inventory_summary.current_stock", 0],
              },
              0,
            ],
          },

          total_recent_sales: {
            $sum: "$recent_sales_30_days.quantity",
          },
        },
      },

      /*
       * Create the final JSON structure.
       */
      {
        $project: {
          _id: 0,

          product_id: 1,
          name: 1,

          pricing: {
            mrp: {
              $ifNull: ["$pricing.mrp", 0],
            },
            cp: {
              $ifNull: ["$pricing.cp", 0],
            },
            sp: {
              $ifNull: ["$pricing.sp", 0],
            },
          },

          inventory: {
            min_stock: {
              $ifNull: ["$inventory.min_stock_to_keep", 0],
            },

            max_stock: {
              $ifNull: ["$inventory.max_stock_to_keep", 0],
            },

            current_stock: {
              /*
               * Prevent a negative value in the output.
               * Remove $max if negative inventory is allowed.
               */
              $max: [0, "$current_stock"],
            },
          },

          upcoming_replenishments: 1,
          current_promotions: 1,
          past_promotions: 1,

          sales: {
            sales_velocity_sales_per_day: {
              $round: [
                {
                  $divide: ["$total_recent_sales", RECENT_SALES_DAYS],
                },
                2,
              ],
            },

            sales_velocity_unit: {
              $literal: "units_per_day",
            },

            recent_sales_30_days: "$recent_sales_30_days",
          },

          sales_previous_years_around_same_date: 1,
        },
      },

      {
        $sort: {
          product_id: 1,
        },
      },
    ];

    const cursor = productsCollection.aggregate(pipeline, {
      allowDiskUse: true,
      batchSize: 100,
    });

    const riskCollection = db.collection("products_risk_analysis");
    await riskCollection.createIndex({ product_id: 1 }, { unique: true });
    const stats = { scored: 0, high: 0, llmAnalyzed: 0, reused: 0, failed: 0 };
    for await (const aggregatedProduct of cursor) {
      stats.scored++;
      const productId = aggregatedProduct.product_id;
      const scoring = calculateRiskScores(aggregatedProduct);
      const previous = await riskCollection.findOne(
        { product_id: productId },
        {
          projection: { input_hash: 1, llm_analyzed_at: 1, risk_analysis: 1 },
        },
      );
      const inputHash = createHash("sha256")
        .update(
          JSON.stringify({
            scoring_version: scoring.scoring_version,
            factor_scores: scoring.factor_scores,
            scoring_metrics: scoring.scoring_metrics,
            current_promotions: aggregatedProduct.current_promotions,
            upcoming_replenishments: aggregatedProduct.upcoming_replenishments,
            past_promotions: aggregatedProduct.past_promotions,
            historical_sales:
              aggregatedProduct.sales_previous_years_around_same_date,
          }),
        )
        .digest("hex");
      let explanation = {};
      let explanationStatus = "not_required";
      if (scoring.overall_risk === "high") {
        stats.high++;
        const fresh =
          previous?.llm_analyzed_at &&
          Date.now() - new Date(previous.llm_analyzed_at).getTime() <
            24 * 60 * 60 * 1000;
        if (
          previous?.input_hash === inputHash &&
          fresh &&
          previous?.risk_analysis?.factor_explanations
        ) {
          explanation = {
            factor_explanations: previous.risk_analysis.factor_explanations,
            factor_models: previous.risk_analysis.factor_models,
            reason: previous.risk_analysis.reason,
          };
          explanationStatus = "cached";
          stats.reused++;
        } else {
          const result = await getRiskAnalysis(aggregatedProduct, scoring);
          if (result) {
            explanation = result;
            explanationStatus = "generated";
            stats.llmAnalyzed++;
          } else {
            explanationStatus = "failed";
            stats.failed++;
          }
        }
      }
      await riskCollection.updateOne(
        { product_id: productId },
        {
          $set: {
            product_id: productId,
            input: aggregatedProduct,
            input_hash: inputHash,
            risk_analysis: {
              ...scoring,
              ...explanation,
              explanation_status: explanationStatus,
            },
            analyzed_at: new Date(),
            llm_analyzed_at:
              explanationStatus === "generated"
                ? new Date()
                : explanationStatus === "cached"
                  ? previous.llm_analyzed_at
                  : null,
          },
        },
        { upsert: true },
      );
    }
    console.log("Risk refresh:", stats);

    console.log(`Successfully analyised ${stats.scored} products`);
  } catch (error) {
    console.error("Product aggregation failed:", error);
    process.exitCode = 1;
  } finally {
    await mongoDbClient.close();
    console.log("MongoDB connection closed");
  }
}

aggregateProducts();

// Six separately orchestrated calls, one factor explanation per request.
// Numeric risk values come exclusively from calculateRiskScores().
const TASKS = [
  [
    "days_left",
    "typhoon-v2.5-30b-a3b-instruct",
    (p) => ({
      inventory: p.inventory,
      velocity: p.sales?.sales_velocity_sales_per_day,
    }),
  ],
  [
    "replenishment",
    "typhoon-v2.5-30b-a3b-instruct",
    (p) => ({
      inventory: p.inventory,
      replenishments: p.upcoming_replenishments,
    }),
  ],
  ["sales_trend", "typhoon-v2.1-12b-instruct", (p) => ({ sales: p.sales })],
  [
    "promotion",
    "typhoon-v2.1-12b-instruct",
    (p) => ({ promotions: p.current_promotions, inventory: p.inventory }),
  ],
  [
    "promotion_calendar",
    "typhoon-v2.5-30b-a3b-instruct",
    (p) => ({
      past_promotions: p.past_promotions,
      current_promotions: p.current_promotions,
    }),
  ],
  [
    "historical_sales",
    "typhoon-v2.1-12b-instruct",
    (p) => ({
      historical_sales: p.sales_previous_years_around_same_date,
      velocity: p.sales?.sales_velocity_sales_per_day,
    }),
  ],
];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function explainFactor(product, scoring, task) {
  const [key, defaultModel, select] = task;
  const model = process.env[`RISK_MODEL_${key.toUpperCase()}`] || defaultModel;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model,
        messages: [
          {
            role: "system",
            content:
              "Explain one inventory risk factor using provided evidence. Do not invent facts. Return JSON with a single nonempty 'reason' string.",
          },
          {
            role: "user",
            content: JSON.stringify({
              factor: key,
              numerical_score: scoring.factor_scores[key],
              overall_risk: scoring.overall_risk,
              scoring_metrics: scoring.scoring_metrics,
              data: select(product),
            }),
          },
        ],
        temperature: 0.2,
        max_completion_tokens: 200,
        response_format: { type: "json_object" },
      });
      const result = JSON.parse(
        response.choices?.[0]?.message?.content || "null",
      );
      if (typeof result?.reason !== "string" || !result.reason.trim())
        throw new Error("Invalid reason");
      return { key, model, reason: result.reason.trim() };
    } catch (error) {
      if (attempt === 2) throw new Error(`${key}: ${error.message}`);
      await pause(500 * 2 ** attempt);
    }
  }
}
async function getRiskAnalysis(product, scoring) {
  // Three calls at a time, six total; retry each failed call up to three attempts.
  const results = new Array(TASKS.length);
  let next = 0;
  const concurrency = Math.max(
    1,
    Math.min(6, Number(process.env.RISK_LLM_CONCURRENCY) || 3),
  );
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < TASKS.length) {
        const index = next++;
        try {
          results[index] = await explainFactor(product, scoring, TASKS[index]);
        } catch (error) {
          results[index] = { error: error.message };
        }
      }
    }),
  );
  const failures = results.filter((result) => result.error);
  if (failures.length) {
    console.error(
      `Incomplete explanations for ${product.product_id}:`,
      failures.map((f) => f.error).join("; "),
    );
    return null;
  }
  return {
    factor_explanations: Object.fromEntries(
      results.map((r) => [r.key, r.reason]),
    ),
    factor_models: Object.fromEntries(results.map((r) => [r.key, r.model])),
    reason: results.map((r) => `${r.key}: ${r.reason}`).join(" "),
  };
}

const MODEL = "google/gemma-4-26b-a4b-it-maas";

async function chat(message) {
  const url =
    `https://${ENDPOINT}/v1/projects/${PROJECT_ID}` +
    `/locations/${REGION}/endpoints/openapi/chat/completions`;

  const response = await fetch(url, {
    method: "POST",

    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },

    body: JSON.stringify({
      model: MODEL,
      stream: false,
      max_tokens: 128000,
      messages: [
        {
          role: "user",
          content: message,
        },
      ],
      chat_template_kwargs: {
        enable_thinking: true,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemma API error ${response.status}: ${error}`);
  }

  return await response.json();
}
