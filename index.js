const express = require('express')
const cors = require('cors')
require('dotenv').config()
const app = express()
const port = process.env.PORT || 5000
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = process.env.URI;

// midlware
app.use(cors())
app.use(express.json())

app.get('/', (req, res) => {
    res.send('Hello World!')
})

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

const run = async () => {
    try {
        await client.connect();
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
        const database = client.db("ScholarLink");
        const userCollections = database.collection('users')
        const scholarshipsCollections = database.collection('scholarships')

        // users add to db
        app.post('/users', async (req, res) => {
            const newUser = req.body
            const user = { ...newUser, role: 'Student' }
            try {
                const find = await userCollections.findOne({ email: newUser?.email })
                if (find) {
                    res.status(200).json({ success: true, message: 'Already have an account using this email' })
                }
                if (!find) {
                    const result = await userCollections.insertOne(user)
                    res.status(200).json({ success: true, data: result })
                }
            } catch (error) {
                res.status(400).json({ message: error.message })
            }
        })
        // scholarships get
        app.get('/scholarships',async (req,res)=>{
            const filter = {}
            try {
                const result = await scholarshipsCollections.find(filter).toArray()
                res.status(200).json({ success: true, data: result })
            } catch (error) {
                res.status(400).json({ message: error.message })
            }
        })
        // top scholarships get
        app.get('/top-scholarships',async (req,res)=>{
            const filter = {}
            try {
                const result = await scholarshipsCollections.find(filter).sort({tuition_fees: 1}).limit(6).toArray()
                res.status(200).json({ success: true, data: result })
            } catch (error) {
                res.status(400).json({ message: error.message })
            }
        })
        // get sinfle scholarships
        app.get('/scholarships/:id',async(req,res)=>{
            const id = req.params
            const filter = {_id: new ObjectId(id)}
            try {
                const result = await scholarshipsCollections.findOne(filter)
                res.status(200).json({ success: true, data: result })
            } catch (error) {
                res.status(400).json({ message: error.message })
            }
        })
    } finally {
        // await client.close();
    }
}
run().catch(console.dir);



app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})
