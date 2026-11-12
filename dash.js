import express from "express";
import { MongoClient } from "mongodb";
import "dotenv/config";
import os from "os";
import { checkDiskSpace } from "check-disk-space";

const originalLog = console.log;
const originalError = console.error;

const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

console.log = (...args) => {
  originalLog(`${YELLOW}[DASH-SERVICE]${RESET}`, ...args);
};

console.error = (...args) => {
  originalError(`${YELLOW}[DASH-SERVICE]${RESET}`, ...args);
};

const app = express();

const PORT = process.env.PORT || 4000;
const PAGE_SIZE = 10;

const client = new MongoClient(
  process.env.MONGODB_URI ||
    `mongodb+srv://ms555app_db_user:l5MztOUjHXml6KKI@c0.uoosfng.mongodb.net/`,
);

let db;

async function connectDB() {
  await client.connect();

  db = client.db(process.env.MONGODB_DB_NAME || `retail_inventory_db`);

  console.log("MongoDB connected");
}

app.get("/risky-products", async (req, res) => {
  try {
    let page = parseInt(req.query.page) || 1;
    const search = req.query.search?.trim() || "";

    if (page < 1) {
      page = 1;
    }

    const skip = (page - 1) * PAGE_SIZE;

    const searchFilter = {};

    if (search) {
      searchFilter.$or = [
        {
          product_id: {
            $regex: search,
            $options: "i",
          },
        },
        {
          "input.name": {
            $regex: search,
            $options: "i",
          },
        },
      ];
    }

    const pipeline = [
      {
        $match: searchFilter,
      },

      {
        $addFields: {
          risk_priority: {
            $switch: {
              branches: [
                {
                  case: {
                    $eq: ["$risk_analysis.overall_risk", "high"],
                  },
                  then: 3,
                },
                {
                  case: {
                    $eq: ["$risk_analysis.overall_risk", "medium"],
                  },
                  then: 2,
                },
                {
                  case: {
                    $eq: ["$risk_analysis.overall_risk", "low"],
                  },
                  then: 1,
                },
              ],
              default: 0,
            },
          },
        },
      },

      {
        $sort: {
          risk_priority: -1,
          "risk_analysis.risk_score": -1,
          analyzed_at: -1,
          product_id: 1,
        },
      },

      {
        $facet: {
          metadata: [
            {
              $count: "total",
            },
          ],

          data: [
            {
              $skip: skip,
            },
            {
              $limit: PAGE_SIZE,
            },

            {
              $project: {
                _id: 0,

                product_id: 1,

                name: "$input.name",

                pricing: "$input.pricing",

                inventory: "$input.inventory",

                sales_velocity: "$input.sales.sales_velocity_sales_per_day",

                upcoming_replenishments: "$input.upcoming_replenishments",

                current_promotions: "$input.current_promotions",

                risk_analysis: 1,

                analyzed_at: 1,
              },
            },
          ],
        },
      },
    ];

    const [result] = await db
      .collection("products_risk_analysis")
      .aggregate(pipeline)
      .toArray();

    const total = result.metadata[0]?.total || 0;

    const totalPages = Math.ceil(total / PAGE_SIZE);

    res.json({
      page,
      page_size: PAGE_SIZE,
      total_records: total,
      total_pages: totalPages,
      has_next_page: page < totalPages,
      has_previous_page: page > 1,
      search: search || null,
      products: result.data,
    });
  } catch (error) {
    console.error("Failed to fetch risky products:", error);

    res.status(500).json({
      error: "Failed to fetch risky products",
    });
  }
});

const startTimeUtc = new Date().toISOString();

app.get("/health", async (req, res) => {
  try {
    // CPU usage
    const cpuUsage = process.cpuUsage();
    const cpuUsageMs = {
      user: cpuUsage.user / 1000,
      system: cpuUsage.system / 1000,
    };

    // Memory usage
    const memory = process.memoryUsage();

    const memUsage = {
      usedMB: +(memory.rss / 1024 / 1024).toFixed(2),
      heapUsedMB: +(memory.heapUsed / 1024 / 1024).toFixed(2),
      heapTotalMB: +(memory.heapTotal / 1024 / 1024).toFixed(2),
    };

    // Disk usage
    const disk = await checkDiskSpace(
      process.platform === "win32" ? "C:" : "/",
    );

    const diskUsage = {
      totalGB: +(disk.size / 1024 ** 3).toFixed(2),
      freeGB: +(disk.free / 1024 ** 3).toFixed(2),
      usedGB: +((disk.size - disk.free) / 1024 ** 3).toFixed(2),
      usedPercent: +(((disk.size - disk.free) / disk.size) * 100).toFixed(2),
    };

    res.status(200).json({
      running: true,
      cpuUsage: cpuUsageMs,
      memUsage,
      diskUsage,
      startTimeUtc,
    });
  } catch (error) {
    console.error("Health check failed:", error);

    res.status(500).json({
      running: false,
      error: error.message,
      startTimeUtc,
    });
  }
});

async function startServer() {
  try {
    await connectDB();

    app.listen(PORT, () => {
      console.log(`Dashboard API running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
