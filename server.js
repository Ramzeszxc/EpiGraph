require('dotenv').config();
const express = require('express');
const neo4j = require('neo4j-driver');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD));

const getSafeId = (val) => val ? (val.toString ? val.toString() : String(val)) : null;

async function initializeDatabaseSchema() {
    const session = driver.session();
    try {
        await session.run('CREATE CONSTRAINT unique_person_name IF NOT EXISTS FOR (p:Person) REQUIRE p.name IS UNIQUE');
        await session.run('CREATE CONSTRAINT unique_location_name IF NOT EXISTS FOR (l:Location) REQUIRE l.name IS UNIQUE');
        await session.run('CREATE INDEX person_status_idx IF NOT EXISTS FOR (p:Person) ON (p.status)');
        console.log("Enterprise Schema Initialized.");
    } catch (error) {
        console.error("Schema Init Warning:", error.message);
    } finally {
        await session.close();
    }
}
initializeDatabaseSchema();

app.get('/api/dashboard', async (req, res) => {
    const session = driver.session();
    try {
        const dataResult = await session.run('MATCH (n) OPTIONAL MATCH (n)-[r]->(m) RETURN n, r, m');
        const nodes = [], edges = [];
        const seenNodes = new Set();

        dataResult.records.forEach(record => {
            ['n', 'm'].forEach(key => {
                const node = record.get(key);
                if (node) {
                    const id = getSafeId(node.identity);
                    if (!seenNodes.has(id)) {
                        seenNodes.add(id);
                        nodes.push({ id, label: node.properties.name, group: node.labels[0], properties: node.properties });
                    }
                }
            });
            const r = record.get('r');
            if (r) {
                edges.push({ id: getSafeId(r.identity), from: getSafeId(r.start), to: getSafeId(r.end), label: r.type, properties: r.properties });
            }
        });
        res.json({ nodes, edges });
    } catch (error) { res.status(500).json({ error: error.message }); } 
    finally { await session.close(); }
});

app.post('/api/person', async (req, res) => {
    const { name, status, loggedBy } = req.body;
    const session = driver.session();
    try {
        const result = await session.run(`
            MERGE (p:Person {name: $name})
            ON CREATE SET p.status = $status, p.registeredAt = timestamp(), p.loggedBy = $loggedBy
            ON MATCH SET p.status = $status, p.lastUpdatedAt = timestamp(), p.updatedBy = $loggedBy
            RETURN p
        `, { name, status, loggedBy: loggedBy || 'SYSTEM' });
        res.status(201).json({ success: true, data: result.records[0].get('p').properties });
    } catch (error) { res.status(500).json({ error: error.message }); } 
    finally { await session.close(); }
});

app.post('/api/location', async (req, res) => {
    const { name, type, loggedBy } = req.body;
    const session = driver.session();
    try {
        const result = await session.run(`
            MERGE (l:Location {name: $name})
            ON CREATE SET l.type = $type, l.registeredAt = timestamp(), l.loggedBy = $loggedBy
            RETURN l
        `, { name, type, loggedBy: loggedBy || 'SYSTEM' });
        res.status(201).json({ success: true, data: result.records[0].get('l').properties });
    } catch (error) { res.status(500).json({ error: error.message }); } 
    finally { await session.close(); }
});

app.post('/api/contact', async (req, res) => {
    const { person1, person2, date, duration, officerId } = req.body;
    const session = driver.session();
    try {
        await session.run(`
            MATCH (a:Person {name: $person1}), (b:Person {name: $person2})
            MERGE (a)-[r:CONTACTED {date: $date}]->(b)
            SET r.duration = $duration, r.audit_loggedBy = $officerId, r.audit_timestamp = timestamp()
        `, { person1, person2, date, duration, officerId });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); } 
    finally { await session.close(); }
});

app.post('/api/visit', async (req, res) => {
    const { person, location, date, officerId } = req.body;
    const session = driver.session();
    try {
        await session.run(`
            MATCH (p:Person {name: $person}), (l:Location {name: $location})
            MERGE (p)-[r:VISITED {date: $date}]->(l)
            SET r.audit_loggedBy = $officerId, r.audit_timestamp = timestamp()
        `, { person, location, date, officerId });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); } 
    finally { await session.close(); }
});

app.get('/api/trace/:name', async (req, res) => {
    const name = req.params.name;
    const session = driver.session();
    try {
        let result = await session.run(`
            MATCH (p:Person {name: $name})
            OPTIONAL MATCH (p)-[:CONTACTED]-(direct:Person)
            OPTIONAL MATCH (p)-[:VISITED]->(l:Location)<-[:VISITED]-(indirect:Person)
            OPTIONAL MATCH (direct)-[:CONTACTED]-(secDegree:Person)
            RETURN p, collect(distinct direct) as directContacts, collect(distinct l) as environments, collect(distinct indirect) as environmentalExposures, collect(distinct secDegree) as secondaryContacts
        `, { name });

        if (result.records.length > 0) {
            const record = result.records[0];
            return res.json({
                type: 'Person',
                root: record.get('p').properties,
                directContacts: record.get('directContacts').map(n => n.properties),
                environments: record.get('environments').map(n => n.properties),
                environmentalExposures: record.get('environmentalExposures').map(n => n.properties),
                secondaryContacts: record.get('secondaryContacts').map(n => n.properties)
            });
        }

        result = await session.run(`
            MATCH (l:Location {name: $name})
            OPTIONAL MATCH (p:Person)-[v:VISITED]->(l)
            RETURN l, collect({person: p, date: v.date, officer: v.audit_loggedBy}) as visitors
        `, { name });

        if (result.records.length > 0) {
            const record = result.records[0];
            return res.json({
                type: 'Location',
                root: record.get('l').properties,
                visitors: record.get('visitors').filter(v => v.person !== null).map(v => ({ 
                    name: v.person.properties.name, status: v.person.properties.status, date: v.date, officer: v.officer || 'SYSTEM' 
                }))
            });
        }
        res.status(404).json({ error: "Profile or Location not found." });
    } catch (error) { res.status(500).json({ error: error.message }); } 
    finally { await session.close(); }
});

app.put('/api/person/:name', async (req, res) => {
    const { status, officerId } = req.body;
    const session = driver.session();
    try {
        await session.run(`
            MATCH (p:Person {name: $name})
            SET p.status = $status, p.lastUpdatedAt = timestamp(), p.updatedBy = $officerId
        `, { name: req.params.name, status, officerId: officerId || 'SYSTEM' });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); } 
    finally { await session.close(); }
});

app.delete('/api/node/:name', async (req, res) => {
    const session = driver.session();
    try {
        await session.run('MATCH (n {name: $name}) DETACH DELETE n', { name: req.params.name });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); } 
    finally { await session.close(); }
});

app.delete('/api/lifecycle/purge', async (req, res) => {
    const session = driver.session();
    try {
        const purgeDate = new Date();
        purgeDate.setDate(purgeDate.getDate() - 21);
        const threshold = purgeDate.toISOString().split('T')[0];

        const result = await session.run(`
            MATCH ()-[r]-() WHERE r.date < $threshold AND (type(r) = 'CONTACTED' OR type(r) = 'VISITED')
            DELETE r RETURN count(r) as deletedCount
        `, { threshold });
        res.json({ success: true, message: `Purged ${result.records[0].get('deletedCount').toNumber()} stale exposure vectors.` });
    } catch (error) { res.status(500).json({ error: error.message }); } 
    finally { await session.close(); }
});

app.get('/api/path', async (req, res) => {
    const { source, target } = req.query;
    const session = driver.session();
    try {
        const validation = await session.run('MATCH (start:Person {name: $source}) RETURN start.status AS status', { source });
        if (validation.records.length === 0) return res.status(404).json({ error: "Source profile not found." });
        
        if (validation.records[0].get('status') === 'Healthy') {
            return res.status(400).json({ error: "Biological Constraint Error: A 'Healthy' profile cannot originate a viral chain." });
        }

        const result = await session.run(`
            MATCH (start:Person {name: $source}), (end:Person {name: $target})
            MATCH path = shortestPath((start)-[*]-(end))
            RETURN nodes(path) AS pathNodes, relationships(path) AS pathEdges
        `, { source, target });

        if (result.records.length === 0) return res.status(404).json({ error: "No transmission path found." });

        res.json({
            nodes: result.records[0].get('pathNodes').map(n => ({ name: n.properties.name, type: n.labels[0], status: n.properties.status || 'N/A' })),
            edges: result.records[0].get('pathEdges').map(e => e.type)
        });
    } catch (error) { res.status(500).json({ error: error.message }); } 
    finally { await session.close(); }
});

app.get('/api/backup', async (req, res) => {
    const session = driver.session();
    try {
        const result = await session.run('MATCH (n) OPTIONAL MATCH (n)-[r]->(m) RETURN n, r, m');
        const databaseDump = result.records.map(rec => ({
            sourceNode: { labels: rec.get('n')?.labels, properties: rec.get('n')?.properties },
            connection: rec.get('r')?.type,
            targetNode: rec.get('m') ? { labels: rec.get('m')?.labels, properties: rec.get('m')?.properties } : null
        }));
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename=epigraph_backup.json');
        res.send(JSON.stringify(databaseDump, null, 2));
    } catch (error) { res.status(500).send("Extraction error."); } 
    finally { await session.close(); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`EpiGraph Command Node active on port ${PORT}`));