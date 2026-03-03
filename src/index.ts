import express, { Request, Response } from 'express';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const app = express();
app.use(express.json());

// Serve static files
const publicPath = path.join(process.cwd(), 'public');
app.use(express.static(publicPath));

app.get('/', (req: Request, res: Response) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Test DB connection
pool.query('SELECT NOW()')
  .then(() => console.log('✅ Connected to Supabase successfully.'))
  .catch((err) => console.error('❌ Database connection failed:', err.stack));

app.post('/identify', async (req: Request, res: Response) => {
  const { email, phoneNumber } = req.body;
  const phoneStr = phoneNumber ? String(phoneNumber) : null;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1️⃣ Find contacts matching email or phone (ignore deleted)
    const searchRes = await client.query(
      `SELECT * FROM "Contact"
       WHERE ("email" = $1 OR "phoneNumber" = $2)
       AND "deletedAt" IS NULL`,
      [email, phoneStr]
    );

    let matchedContacts = searchRes.rows;

    // 2️⃣ If no match → create new primary
    if (matchedContacts.length === 0) {
      const newContact = await client.query(
        `INSERT INTO "Contact" ("email", "phoneNumber", "linkPrecedence")
         VALUES ($1, $2, 'primary')
         RETURNING *`,
        [email, phoneStr]
      );

      await client.query('COMMIT');

      return res.status(200).json(
        formatResponse(newContact.rows[0], [])
      );
    }

    // 3️⃣ Collect all related contacts (cluster)
    const ids = matchedContacts.map(c => c.linkedId || c.id);

    const clusterRes = await client.query(
      `SELECT * FROM "Contact"
       WHERE ("id" = ANY($1::int[]) OR "linkedId" = ANY($1::int[]))
       AND "deletedAt" IS NULL`,
      [ids]
    );

    let allRelated = clusterRes.rows;

    // 4️⃣ Identify true primary (oldest)
    allRelated.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() -
        new Date(b.createdAt).getTime()
    );

    const primaryContact =
      allRelated.find(c => c.linkPrecedence === 'primary') ||
      allRelated[0];

    // 5️⃣ Check if new secondary needed
    const isNewEmail =
      email && !allRelated.some(c => c.email === email);

    const isNewPhone =
      phoneStr && !allRelated.some(c => c.phoneNumber === phoneStr);

    if (isNewEmail || isNewPhone) {
      const newSecondary = await client.query(
        `INSERT INTO "Contact"
         ("email", "phoneNumber", "linkedId", "linkPrecedence")
         VALUES ($1, $2, $3, 'secondary')
         RETURNING *`,
        [email, phoneStr, primaryContact.id]
      );

      allRelated.push(newSecondary.rows[0]);
    }

    // 6️⃣ Merge multiple primaries if present
    const otherPrimaries = allRelated.filter(
      c => c.linkPrecedence === 'primary' && c.id !== primaryContact.id
    );

    for (const p of otherPrimaries) {
      await client.query(
        `UPDATE "Contact"
         SET "linkPrecedence" = 'secondary',
             "linkedId" = $1,
             "updatedAt" = NOW()
         WHERE "id" = $2`,
        [primaryContact.id, p.id]
      );

      p.linkPrecedence = 'secondary';
      p.linkedId = primaryContact.id;
    }

    await client.query('COMMIT');

    return res.status(200).json(
      formatResponse(primaryContact, allRelated)
    );

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    return res.status(500).json({ error: "Internal Server Error" });
  } finally {
    client.release();
  }
});

function formatResponse(primary: any, all: any[]) {
  const emails = Array.from(
    new Set(
      [primary.email, ...all.map(c => c.email)].filter(Boolean)
    )
  );

  const phones = Array.from(
    new Set(
      [primary.phoneNumber, ...all.map(c => c.phoneNumber)].filter(Boolean)
    )
  );

  const secondaryIds = all
    .filter(c => c.id !== primary.id)
    .map(c => c.id);

  return {
    contact: {
      primaryContactId: primary.id,   // ✅ FIXED TYPO
      emails,
      phoneNumbers: phones,
      secondaryContactIds: secondaryIds
    }
  };
}

// Render-safe port binding
const PORT = process.env.PORT || 3000;
app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`🚀 Server live on port ${PORT}`);
});