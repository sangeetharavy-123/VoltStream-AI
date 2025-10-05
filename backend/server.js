const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// Database Setup
const db = new sqlite3.Database(path.join(__dirname, "feedback.db"), (err) => {
    if (err) console.error("❌ Database error:", err.message);
    else console.log("✅ SQLite database connected!");
});

// Create feedback table
db.run(`CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    text TEXT NOT NULL,
    source TEXT,
    sentiment TEXT,
    urgency INTEGER,
    impact INTEGER,
    priority INTEGER,
    owner TEXT,
    rationale TEXT, 
    status TEXT DEFAULT 'NEW',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`, (err) => {
    if (err) console.error("❌ Table creation error:", err);
    else console.log("✅ Feedback table ready!");
});

// AI Prioritization Logic
function aiPrioritizeAndCategorize(text, sentiment, source) {
    let score = 0;
    let rationale = [];
    let keywords = [];

    // Base score from sentiment
    let baseScore = 0;
    if (sentiment === 'Negative') baseScore = 6;
    else if (sentiment === 'Neutral') baseScore = 3;
    else if (sentiment === 'Positive') baseScore = 1;
    
    score += baseScore;
    rationale.push({ label: `Base Score (Sentiment: ${sentiment})`, value: baseScore });

    // Keyword analysis with weights
    const keywordWeights = {
        'canceling': 5,
        'cancel': 4,
        'refund': 4,
        'money back': 3,
        'charged twice': 5,
        'billing': 3,
        'bug': 3,
        'crash': 4,
        'error': 2,
        'broken': 3,
        'failed': 2,
        'not working': 3,
        'immediately': 2,
        'urgent': 3,
        'critical': 4,
        'unacceptable': 2,
        'terrible': 2,
        'slow': 2,
        'confusing': 1,
        'feature request': 1,
        'suggestion': 1
    };

    const lowerText = text.toLowerCase();
    let keywordBoost = 0;

    Object.entries(keywordWeights).forEach(([word, weight]) => {
        if (lowerText.includes(word)) {
            keywordBoost += weight;
            keywords.push(word);
            rationale.push({ label: `Keyword Match: "${word}"`, value: weight });
        }
    });
    
    score += keywordBoost;

    // Source multiplier (Zendesk and Slack are high priority channels)
    let multiplier = 1.0;
    if (source === 'Zendesk' || source === 'Slack') {
        multiplier = 1.2;
    }
    
    score = Math.round(score * multiplier);
    rationale.push({ label: `Source Multiplier (${source})`, value: `x${multiplier.toFixed(1)}` });

    // Owner assignment based on keywords
    let owner = 'Product/UX';
    
    if (keywords.some(k => ['bug', 'error', 'failed', 'crash', 'broken', 'not working'].includes(k))) {
        owner = 'Engineering';
    } else if (keywords.some(k => ['money back', 'charged twice', 'canceling', 'cancel', 'refund', 'billing'].includes(k))) {
        owner = 'Billing/Finance';
    } else if (keywords.some(k => ['immediately', 'urgent', 'critical', 'unacceptable', 'terrible'].includes(k))) {
        owner = 'Support/Triage';
    }

    return {
        priority: score,
        owner: owner,
        rationale: JSON.stringify(rationale)
    };
}

// API Routes

// Add new feedback
app.post("/feedback/add", (req, res) => {
    const { title, text, source, sentiment, status } = req.body;

    if (!text) {
        return res.status(400).json({ error: "Feedback text is required" });
    }

    // Auto-detect sentiment if not provided
    let finalSentiment = sentiment || 'Neutral';
    if (!sentiment || sentiment === 'AUTO') {
        const lower = text.toLowerCase();
        if (lower.includes('bug') || lower.includes('error') || lower.includes('crash') || 
            lower.includes('terrible') || lower.includes('unacceptable')) {
            finalSentiment = 'Negative';
        } else if (lower.includes('love') || lower.includes('great') || lower.includes('excellent')) {
            finalSentiment = 'Positive';
        }
    }

    // Run AI analysis
    const analysis = aiPrioritizeAndCategorize(text, finalSentiment, source || "Unknown");

    const sql = `INSERT INTO feedback 
        (title, text, source, sentiment, urgency, impact, priority, owner, rationale, status) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    
    db.run(sql, [
        title || "Untitled Feedback",
        text,
        source || "Unknown",
        finalSentiment,
        4, // Dummy urgency
        4, // Dummy impact
        analysis.priority,
        analysis.owner,
        analysis.rationale,
        status || 'NEW'
    ], function (err) {
        if (err) {
            console.error("❌ Insert error:", err);
            return res.status(500).json({ error: err.message });
        }
        
        console.log(`✅ Feedback added: ID ${this.lastID}, Priority: ${analysis.priority}`);
        res.json({ 
            message: "Feedback added and prioritized!", 
            id: this.lastID, 
            priority: analysis.priority,
            owner: analysis.owner
        });
    });
});

// Update feedback status
app.post("/feedback/update/:id", (req, res) => {
    const id = req.params.id;
    const { status } = req.body;
    
    if (!status) {
        return res.status(400).json({ error: "Status is required" });
    }

    const sql = "UPDATE feedback SET status = ? WHERE id = ?";
    
    db.run(sql, [status, id], function (err) {
        if (err) {
            console.error("❌ Update error:", err);
            return res.status(500).json({ error: err.message });
        }
        
        if (this.changes === 0) {
            return res.status(404).json({ error: "Feedback item not found" });
        }
        
        console.log(`✅ Status updated: ID ${id} -> ${status}`);
        res.json({ message: `Status updated to ${status}` });
    });
});

// Get all feedback (sorted by priority)
app.get("/feedback/all", (req, res) => {
    const sql = "SELECT * FROM feedback ORDER BY priority DESC, created_at DESC";
    
    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error("❌ Query error:", err);
            return res.status(500).json({ error: err.message });
        }
        
        // Parse rationale JSON
        const result = rows.map(row => ({
            ...row,
            rationale: JSON.parse(row.rationale || '[]')
        }));
        
        console.log(`📊 Retrieved ${result.length} feedback items`);
        res.json(result);
    });
});

// Get single feedback by ID
app.get("/feedback/:id", (req, res) => {
    const id = req.params.id;
    const sql = "SELECT * FROM feedback WHERE id = ?";
    
    db.get(sql, [id], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (!row) {
            return res.status(404).json({ error: "Feedback not found" });
        }
        
        row.rationale = JSON.parse(row.rationale || '[]');
        res.json(row);
    });
});

// Delete feedback
app.delete("/feedback/:id", (req, res) => {
    const id = req.params.id;
    const sql = "DELETE FROM feedback WHERE id = ?";
    
    db.run(sql, [id], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (this.changes === 0) {
            return res.status(404).json({ error: "Feedback not found" });
        }
        
        console.log(`🗑️ Deleted feedback: ID ${id}`);
        res.json({ message: "Feedback deleted successfully" });
    });
});

// Get statistics
app.get("/stats", (req, res) => {
    const queries = {
        total: "SELECT COUNT(*) as count FROM feedback",
        highPriority: "SELECT COUNT(*) as count FROM feedback WHERE priority >= 16",
        byStatus: "SELECT status, COUNT(*) as count FROM feedback GROUP BY status",
        byOwner: "SELECT owner, COUNT(*) as count FROM feedback GROUP BY owner",
        bySentiment: "SELECT sentiment, COUNT(*) as count FROM feedback GROUP BY sentiment"
    };

    const stats = {};
    let completed = 0;
    const total = Object.keys(queries).length;

    Object.entries(queries).forEach(([key, query]) => {
        db.all(query, [], (err, rows) => {
            if (!err) {
                stats[key] = Array.isArray(rows) && rows.length > 1 ? rows : rows[0];
            }
            completed++;
            
            if (completed === total) {
                res.json(stats);
            }
        });
    });
});

// Health check
app.get("/health", (req, res) => {
    res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log("=".repeat(50));
    console.log("⚡ VOLTSTREAM BACKEND SERVER");
    console.log("=".repeat(50));
    console.log(`✅ Server running at http://localhost:${PORT}`);
    console.log(`📊 Database: ${path.join(__dirname, "feedback.db")}`);
    console.log("=".repeat(50));
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log("\n🛑 Shutting down gracefully...");
    db.close((err) => {
        if (err) console.error(err);
        else console.log("✅ Database connection closed");
        process.exit(0);
    });
});