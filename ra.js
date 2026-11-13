import "dotenv/config";
import { MongoClient } from "mongodb";
import OpenAI from "openai";

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
  OPENAI_API_KEY = "sk-9LxaofOOi1gAdqTOKQhOsdqLFEfIYuT7VEFXfLS03AJIly1W",

  ENDPOINT = "aiplatform.googleapis.com",
  REGION = "global",
  PROJECT_ID = "p000-513919",
  ACCESS_TOKEN = '',
} = process.env;

const mongoDbClient = new MongoClient(MONGODB_URI);
const openai = new OpenAI({
  baseURL: 'https://api.opentyphoon.ai/v1',
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
      subtractDays(todayStart, RECENT_SALES_DAYS - 1)
    );

    const previousYearSameDate = subtractYears(todayStart, 1);

    const previousYearStartDate = getStartOfDay(
      subtractDays(previousYearSameDate, PREVIOUS_YEAR_WINDOW_DAYS)
    );

    const previousYearEndDate = getEndOfDay(
      addDays(previousYearSameDate, PREVIOUS_YEAR_WINDOW_DAYS)
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
                            $eq: [
                              "$product_id",
                              "$$salesProductId",
                            ],
                          },
                          {
                            $gte: [
                              "$created_at",
                              "$$salesWindowStart",
                            ],
                          },
                          {
                            $lte: [
                              "$created_at",
                              "$$salesWindowEnd",
                            ],
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
                              $lt: [
                                "$created_at",
                                "$$promotionStartDate",
                              ],
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
                                  $gte: [
                                    "$created_at",
                                    "$$promotionStartDate",
                                  ],
                                },
                                {
                                  $lte: [
                                    "$created_at",
                                    "$$promotionEndDate",
                                  ],
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
                              $gt: [
                                "$created_at",
                                "$$promotionEndDate",
                              ],
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
                      $arrayElemAt: [
                        "$promotion_sales_summary",
                        0,
                      ],
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
                            $max: [
                              1,
                              "$promotion_duration_days",
                            ],
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
                      $gte: [
                        "$created_at",
                        recentSalesStartDate,
                      ],
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
                      $gte: [
                        "$created_at",
                        previousYearStartDate,
                      ],
                    },
                    {
                      $lte: [
                        "$created_at",
                        previousYearEndDate,
                      ],
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
                $arrayElemAt: [
                  "$inventory_summary.current_stock",
                  0,
                ],
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
              $ifNull: [
                "$inventory.min_stock_to_keep",
                0,
              ],
            },

            max_stock: {
              $ifNull: [
                "$inventory.max_stock_to_keep",
                0,
              ],
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
                  $divide: [
                    "$total_recent_sales",
                    RECENT_SALES_DAYS,
                  ],
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

    let numberOfProducts = 0;

    for await (const aggregatedProduct of cursor) {
      numberOfProducts += 1;

      console.log(`aggregatedProduct`, JSON.stringify(aggregatedProduct, null, 2));

      const riskResult = await getRiskAnalysis(
        aggregatedProduct
      );

      if (riskResult === null) continue;

      console.log(`Risk analysed for ${numberOfProducts}: ${aggregatedProduct.product_id}`);

      await db.collection("products_risk_analysis").updateOne(
        { product_id: aggregatedProduct.product_id },
        {
          $set: {
            product_id: aggregatedProduct.product_id, // product.product_id
            input: aggregatedProduct, // what analysis is run on
            risk_analysis: riskResult, // analysis result
            analyzed_at: new Date() // last analysis result
          }
        },
        { upsert: true }
      );
    }

    console.log(
      `Successfully analyised ${numberOfProducts} products`
    );
  } catch (error) {
    console.error("Product aggregation failed:", error);
    process.exitCode = 1;
  } finally {
    await mongoDbClient.close();
    console.log("MongoDB connection closed");
  }
}

aggregateProducts();

async function getRiskAnalysis(product, noLlm) {
  if (noLlm === true) {
    const risks = ["low", "medium", "high"];

    const randomRisk = () =>
      risks[Math.floor(Math.random() * risks.length)];

    const riskResult = {
      days_left_risk: randomRisk(),
      replenishment_risk: randomRisk(),
      sales_trend_risk: randomRisk(),
      promotion_risk: randomRisk(),
      promotion_calendar_risk: randomRisk(),
      historical_sales_risk: randomRisk()
    };

    const values = Object.values(riskResult);

    let overallRisk = "low";

    if (values.includes("high")) {
      overallRisk = "high";
    } else if (values.includes("medium")) {
      overallRisk = "medium";
    }

    return {
      product_id: product.product_id,
      ...riskResult,
      overall_risk: overallRisk,
      reason: "Mock risk analysis generated without LLM"
    };
  }
  const prompt = `
You are an inventory risk analysis system.

Analyze the following product and determine its inventory risks.

PRODUCT DATA:
${JSON.stringify(product, null, 2)}

Analyze these risk factors:

1. days_left_risk
   Calculate approximately how many days the current stock will last based on sales velocity.

2. replenishment_risk
   Consider upcoming replenishment quantity and expected arrival date.

3. sales_trend_risk
   Compare recent sales with normal sales velocity.

4. promotion_risk
   Consider currently active promotions and whether they may increase sales.

5. promotion_calendar_risk
   Use historical promotion performance to determine whether similar promotions caused higher sales.

6. historical_sales_risk
   Compare current sales behaviour with sales around the same date in previous years.

Return risk as only:
"low", "medium", or "high".

Also calculate overall_risk.

Return ONLY valid JSON in this exact format:

{
  "product_id": "${product.product_id}",
  "days_left_risk": "low",
  "replenishment_risk": "low",
  "sales_trend_risk": "low",
  "promotion_risk": "low",
  "promotion_calendar_risk": "low",
  "historical_sales_risk": "low",
  "overall_risk": "low",
  "reason": "short explanation"
}
`;

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "typhoon-v2.5-30b-a3b-instruct",
      messages: [
        {
          role: "system",
          content:
            "You are an inventory and stock risk analysis system. Return only valid JSON.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.6,
      max_completion_tokens: 512,
      top_p: 0.6,
      frequency_penalty: 0,
      response_format: {
        type: "json_object",
      },
    });

    const content = response.choices[0]?.message?.content;

    if (!content) {
      throw new Error("Empty response from LLM");
    }

    return JSON.parse(content);
  } catch (error) {
    console.error(
      `Risk analysis failed for ${product.product_id}:`,
      error.message
    );

    return null;
  }
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
