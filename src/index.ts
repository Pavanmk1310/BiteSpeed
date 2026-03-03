import express, { Request, Response } from 'express';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json()); // Use JSON Body as required [cite: 228]

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

app.post('/identify', async (req: Request, res: Response) => {
  const { email, phoneNumber } = req.body;

  // 1. Basic Validation [cite: 15]
  if (!email && !phoneNumber) {
    return res.status(400).json({ error: "Email or phoneNumber required" });
  }

  try {
    // 2. Search for existing contacts [cite: 27]
    const existingContactsQuery = await pool.query(
      `SELECT * FROM "Contact" WHERE "email" = $1 OR "phoneNumber" = $2`,
      [email, phoneNumber]
    );
    const matches = existingContactsQuery.rows;

    if (matches.length === 0) {
      // Scenario: New User [cite: 88, 89]
      const newContact = await pool.query(
        `INSERT INTO "Contact" ("email", "phoneNumber", "linkPrecedence") 
         VALUES ($1, $2, 'primary') RETURNING *`,
        [email, phoneNumber]
      );
      return res.json(formatResponse(newContact.rows[0], []));
    }

    // 3. Find all related contacts in the cluster
    // First, find the "true" primary IDs for all matches
    const primaryIds = new Set(matches.map(m => m.linkedId || m.id));
    
    const allRelatedQuery = await pool.query(
      `SELECT * FROM "Contact" WHERE "id" = ANY($1::int[]) OR "linkedId" = ANY($1::int[])`,
      [Array.from(primaryIds)]
    );
    let allRelated = allRelatedQuery.rows;

    // 4. Determine oldest Primary [cite: 26]
    allRelated.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const primaryContact = allRelated.find(c => c.linkPrecedence === 'primary') || allRelated[0];

    // 5. Check if we need to create a new Secondary [cite: 90, 91]
    const hasNewInfo = (email && !allRelated.some(c => c.email === email)) || 
                       (phoneNumber && !allRelated.some(c => c.phoneNumber === String(phoneNumber)));

    if (hasNewInfo) {
      const secondary = await pool.query(
        `INSERT INTO "Contact" ("email", "phoneNumber", "linkedId", "linkPrecedence") 
         VALUES ($1, $2, $3, 'secondary') RETURNING *`,
        [email, String(phoneNumber), primaryContact.id]
      );
      allRelated.push(secondary.rows[0]);
    }

    // 6. Handle Merging of Primaries [cite: 144, 145]
    // If we have multiple primary contacts in the results, convert newer ones to secondary
    const otherPrimaries = allRelated.filter(c => c.linkPrecedence === 'primary' && c.id !== primaryContact.id);
    for (const p of otherPrimaries) {
      await pool.query(
        `UPDATE "Contact" SET "linkPrecedence" = 'secondary', "linkedId" = $1, "updatedAt" = NOW() WHERE "id" = $2`,
        [primaryContact.id, p.id]
      );
      p.linkPrecedence = 'secondary';
      p.linkedId = primaryContact.id;
    }

    // 7. Format final response [cite: 44, 46, 54]
    res.json(formatResponse(primaryContact, allRelated));

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// Helper to consolidate data [cite: 48, 50, 55]
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
app.listen(PORT, () => console.log(`Doc's tracker running on port ${PORT}`));