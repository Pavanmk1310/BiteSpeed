import express, { Request, Response } from 'express';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const app = express();
app.use(express.json());

// Serve the UI files from the 'public' folder
app.use(express.static(path.join(__dirname, '../public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Required for Render/Supabase connection
});

// Test Database Connection
pool.query('SELECT NOW()', (err) => {
  if (err) console.error('❌ Database connection failed:', err.stack);
  else console.log('✅ Connected to Supabase successfully.');
});

app.post('/identify', async (req: Request, res: Response) => {
  const { email, phoneNumber } = req.body;
  const phoneStr = phoneNumber ? String(phoneNumber) : null;

  try {
    // 1. Find all contacts matching either email or phone
    const searchRes = await pool.query(
      `SELECT * FROM "Contact" WHERE "email" = $1 OR "phoneNumber" = $2`,
      [email, phoneStr]
    );
    let matchedContacts = searchRes.rows;

    // 2. Scenario: No existing contact found
    if (matchedContacts.length === 0) {
      const newContact = await pool.query(
        `INSERT INTO "Contact" ("email", "phoneNumber", "linkPrecedence") 
         VALUES ($1, $2, 'primary') RETURNING *`,
        [email, phoneStr]
      );
      return res.status(200).json(formatResponse(newContact.rows[0], []));
    }

    // 3. Find the "Cluster" (all contacts linked to our matches)
    const primaryIds = new Set(matchedContacts.map(c => c.linkedId || c.id));
    const clusterRes = await pool.query(
      `SELECT * FROM "Contact" WHERE "id" = ANY($1::int[]) OR "linkedId" = ANY($1::int[])`,
      [Array.from(primaryIds)]
    );
    let allRelated = clusterRes.rows;

    // 4. Identify the True Primary (the oldest one)
    allRelated.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const primaryContact = allRelated.find(c => c.linkPrecedence === 'primary') || allRelated[0];

    // 5. Logic: Check if we need to create a new Secondary record
    const isNewEmail = email && !allRelated.some(c => c.email === email);
    const isNewPhone = phoneStr && !allRelated.some(c => c.phoneNumber === phoneStr);

    if (isNewEmail || isNewPhone) {
      const newSecondary = await pool.query(
        `INSERT INTO "Contact" ("email", "phoneNumber", "linkedId", "linkPrecedence") 
         VALUES ($1, $2, $3, 'secondary') RETURNING *`,
        [email, phoneStr, primaryContact.id]
      );
      allRelated.push(newSecondary.rows[0]);
    }

    // 6. Logic: Merge existing Primaries if necessary
    const otherPrimaries = allRelated.filter(c => c.linkPrecedence === 'primary' && c.id !== primaryContact.id);
    for (const p of otherPrimaries) {
      await pool.query(
        `UPDATE "Contact" SET "linkPrecedence" = 'secondary', "linkedId" = $1, "updatedAt" = NOW() WHERE "id" = $2`,
        [primaryContact.id, p.id]
      );
      // Update local state to reflect change for the response
      p.linkPrecedence = 'secondary';
      p.linkedId = primaryContact.id;
    }

    res.status(200).json(formatResponse(primaryContact, allRelated));

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

function formatResponse(primary: any, all: any[]) {
  const emails = Array.from(new Set([primary.email, ...all.map(c => c.email)].filter(Boolean)));
  const phones = Array.from(new Set([primary.phoneNumber, ...all.map(c => c.phoneNumber)].filter(Boolean)));
  const secondaryIds = all.filter(c => c.id !== primary.id).map(c => c.id);

  return {
    contact: {
      primaryContatctId: primary.id,
      emails: emails,
      phoneNumbers: phones,
      secondaryContactIds: secondaryIds
    }
  };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));