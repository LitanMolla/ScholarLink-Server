const express = require('express')
const cors = require('cors')
require('dotenv').config()
const serviceAccount = require("./serviceAccountKey.json");
const admin = require("firebase-admin");
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const app = express()
const port = process.env.PORT || 5000
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = process.env.URI;
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
// midlware
app.use(cors())
app.use(express.json())

app.get('/', (req, res) => {
    res.send('Hello World!')
})
const verifyFirebaseToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    console.log(req.headers.authorization)
    if (!authHeader) {
        return res.status(401).send({ message: "Unauthorized" });
    }
    const token = authHeader.split(" ")[1];
    try {
        const decodedUser = await admin.auth().verifyIdToken(token);
        req.user = decodedUser;
        next();
    } catch (error) {
        return res.status(401).send({ message: "Unauthorized" });
    }
};
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});
const run = async () => {
    try {
        // await client.connect();
        // await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
        const database = client.db("ScholarLink");
        const userCollections = database.collection('users')
        const scholarshipsCollections = database.collection('scholarships')
        const applicationsCollections = database.collection('applications');
        const reviewsCollections = database.collection('reviews');
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
        // scholarships get (with search, filter, sort, pagination)
        app.get('/scholarships', async (req, res) => {
            // query params from frontend
            let {
                search = '',
                category = 'all',
                country = 'all',
                sortBy = 'recent',
                page = 1,
                limit = 9,
            } = req.query;
            // string -> number
            page = parseInt(page) || 1;
            limit = parseInt(limit) || 9;
            const skip = (page - 1) * limit;
            // ---------- FILTER ----------
            const filter = {};
            // 🔎 search by name / university / degree
            if (search) {
                const searchRegex = new RegExp(search, 'i'); // case-insensitive
                filter.$or = [
                    { scholarship_name: { $regex: searchRegex } },
                    { university_name: { $regex: searchRegex } },
                    { degree: { $regex: searchRegex } },
                ];
            }
            // filter by scholarship category
            if (category && category !== 'all') {
                filter.scholarship_category = category;
            }

            // filter by country
            if (country && country !== 'all') {
                filter.country = country;
            }
            // ---------- SORT ----------
            const sort = {};
            if (sortBy === 'fee-low') {
                sort.applicationFees = 1;
                sort.tuition_fees = 1;
            } else if (sortBy === 'fee-high') {
                sort.applicationFees = -1;
                sort.tuition_fees = -1;
            } else if (sortBy === 'recent') {
                sort.postDate = -1;
                sort._id = -1;
            }
            try {
                const [items, total] = await Promise.all([
                    scholarshipsCollections
                        .find(filter)
                        .sort(sort)
                        .skip(skip)
                        .limit(limit)
                        .toArray(),
                    scholarshipsCollections.countDocuments(filter),
                ])
                res.status(200).json({
                    success: true,
                    data: items,
                    meta: {
                        total,
                        page,
                        limit,
                        totalPages: Math.ceil(total / limit),
                    },
                });
            } catch (error) {
                res.status(400).json({ success: false, message: error.message });
            }
        });
        // top scholarships get
        app.get('/top-scholarships', async (req, res) => {
            const filter = {}
            try {
                const result = await scholarshipsCollections.find(filter).sort({ tuition_fees: 1 }).limit(6).toArray()
                res.status(200).json({ success: true, data: result })
            } catch (error) {
                res.status(400).json({ message: error.message })
            }
        })
        // get sinfle scholarships
        app.get('/scholarships/:id', async (req, res) => {
            const { id } = req.params;
            const filter = { _id: new ObjectId(id) };
            try {
                const result = await scholarshipsCollections.findOne(filter);
                if (!result) {
                    return res.status(404).json({ success: false, message: "Scholarship not found" });
                }
                res.status(200).json({ success: true, data: result });
            } catch (error) {
                res.status(400).json({ success: false, message: error.message });
            }
        });

        // create checkout session
        app.post('/create-checkout-session', async (req, res) => {
            const { scholarshipId, userEmail, userName } = req.body;

            if (!scholarshipId || !userEmail) {
                return res.status(400).json({ success: false, message: "Missing scholarshipId or userEmail" });
            }

            try {
                // scholarship load kori
                const scholarship = await scholarshipsCollections.findOne({ _id: new ObjectId(scholarshipId) });

                if (!scholarship) {
                    return res.status(404).json({ success: false, message: "Scholarship not found" });
                }

                // applicationFees + serviceCharge (na thakle 0)
                const applicationFees = scholarship.applicationFees || 0;
                const serviceCharge = scholarship.serviceCharge || 0;
                const totalAmount = applicationFees + serviceCharge;

                // Stripe cent e amount ney (USD minni dhore nilam)
                const amountInCents = Math.round(totalAmount * 100);

                // Checkout Session create
                const session = await stripe.checkout.sessions.create({
                    payment_method_types: ['card'],
                    mode: 'payment',
                    customer_email: userEmail,
                    line_items: [
                        {
                            quantity: 1,
                            price_data: {
                                currency: 'usd',
                                unit_amount: amountInCents,
                                product_data: {
                                    name: scholarship.scholarship_name,
                                    description: scholarship.university_name,
                                },
                            },
                        },
                    ],
                    // success & cancel e frontend route use
                    success_url: `${process.env.CLIENT_URL}/payment/success?scholarshipId=${scholarshipId}&amount=${totalAmount}`,
                    cancel_url: `${process.env.CLIENT_URL}/payment/failed?scholarshipId=${scholarshipId}&amount=${totalAmount}`,
                });

                res.status(200).json({
                    success: true,
                    url: session.url,
                });
            } catch (error) {
                console.error(error);
                res.status(500).json({ success: false, message: error.message });
            }
        });
        // Duplicate-safe Create / Update Application (Stripe success/cancel duitar jonno)
        app.post('/applications', async (req, res) => {
            const {
                scholarshipId,
                userEmail,
                userName,
                paymentStatus, // 'paid' | 'unpaid' | 'cancelled' etc.
            } = req.body;

            if (!scholarshipId || !userEmail || !paymentStatus) {
                return res
                    .status(400)
                    .json({ success: false, message: "Missing required fields" });
            }

            try {
                // 🎯 main scholarship data
                const scholarship = await scholarshipsCollections.findOne({
                    _id: new ObjectId(scholarshipId),
                });

                if (!scholarship) {
                    return res
                        .status(404)
                        .json({ success: false, message: "Scholarship not found" });
                }

                // 💰 fees (number + name fallback)
                const applicationFees = Number(
                    scholarship.applicationFees ?? scholarship.application_fees ?? 0
                );

                const serviceCharge = Number(
                    scholarship.serviceCharge ?? scholarship.service_charge ?? 0
                );

                // same user + same scholarship ke always same row dhorbo
                const filter = { scholarshipId, userEmail };

                // applicationStatus ekhane sobar jonno 'pending' rakhchi (later Moderator change korbe)
                const updateDoc = {
                    $set: {
                        scholarshipId,
                        userEmail,
                        userName,
                        universityName: scholarship.university_name,
                        scholarshipName: scholarship.scholarship_name,
                        scholarshipCategory: scholarship.scholarship_category,
                        degree: scholarship.degree,
                        subjectCategory: scholarship.subject_category,
                        applicationFees,
                        serviceCharge,
                        paymentStatus,          // 'paid' / 'unpaid' / 'cancelled'
                        applicationStatus: 'pending',
                        applicationDate: new Date(),
                    },
                    $setOnInsert: {
                        feedback: '',
                        createdAt: new Date(),
                    },
                };

                const options = { upsert: true };

                const result = await applicationsCollections.updateOne(
                    filter,
                    updateDoc,
                    options
                );

                const isNew = !!result.upsertedId;

                return res.status(200).json({
                    success: true,
                    created: isNew,
                    updated: !isNew,
                    message: isNew
                        ? "Application created (upsert)"
                        : "Application updated (upsert)",
                });
            } catch (error) {
                console.error(error);
                return res
                    .status(500)
                    .json({ success: false, message: error.message });
            }
        });
        // Get applications (Student: by email | Moderator/Admin: all)
        app.get("/applications", async (req, res) => {
            const { email } = req.query;

            try {
                const query = email ? { userEmail: email } : {};

                const result = await applicationsCollections
                    .find(query)
                    .sort({ applicationDate: -1 })
                    .toArray();

                res.status(200).json({ success: true, data: result });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        });

        // single app
        app.get('/applications/:id', async (req, res) => {
            const { id } = req.params;

            try {
                const result = await applicationsCollections.findOne({
                    _id: new ObjectId(id),
                });

                if (!result) {
                    return res
                        .status(404)
                        .json({ success: false, message: "Application not found" });
                }

                res.status(200).json({ success: true, data: result });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        });
        // delete 
        app.delete('/applications/:id', async (req, res) => {
            const { id } = req.params;

            try {
                const existing = await applicationsCollections.findOne({
                    _id: new ObjectId(id),
                });

                if (!existing) {
                    return res
                        .status(404)
                        .json({ success: false, message: "Application not found" });
                }

                if (existing.applicationStatus !== 'pending') {
                    return res.status(403).json({
                        success: false,
                        message: "Only pending applications can be deleted",
                    });
                }

                const result = await applicationsCollections.deleteOne({
                    _id: existing._id,
                });

                res.status(200).json({ success: true, data: result });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        });
        // Add review (Student)
        app.post('/reviews', async (req, res) => {
            const {
                scholarshipId,
                universityName,
                scholarshipName,
                userName,
                userEmail,
                userImage,
                ratingPoint,
                reviewComment,
            } = req.body;

            if (!scholarshipId || !userEmail || !ratingPoint || !reviewComment) {
                return res
                    .status(400)
                    .json({ success: false, message: "Missing required fields" });
            }

            try {
                const newReview = {
                    scholarshipId,
                    universityName,
                    scholarshipName,
                    userName,
                    userEmail,
                    userImage,
                    ratingPoint: Number(ratingPoint),
                    reviewComment,
                    reviewDate: new Date(),
                };

                const result = await reviewsCollections.insertOne(newReview);
                res.status(200).json({ success: true, data: result });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        });

        // Get my reviews (Student)
        app.get('/my-reviews', async (req, res) => {
            const { email } = req.query;

            if (!email) {
                return res
                    .status(400)
                    .json({ success: false, message: "Email query is required" });
            }

            try {
                const result = await reviewsCollections
                    .find({ userEmail: email })
                    .sort({ reviewDate: -1 })
                    .toArray();

                res.status(200).json({ success: true, data: result });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        });

        // Update review
        app.patch('/reviews/:id', async (req, res) => {
            const { id } = req.params;
            const { ratingPoint, reviewComment } = req.body;

            try {
                const updateDoc = {
                    $set: {
                        ratingPoint: Number(ratingPoint),
                        reviewComment,
                        reviewDate: new Date(),
                    },
                };

                const result = await reviewsCollections.updateOne(
                    { _id: new ObjectId(id) },
                    updateDoc
                );

                res.status(200).json({ success: true, data: result });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        });

        // Delete review
        app.delete('/reviews/:id', async (req, res) => {
            const { id } = req.params;

            try {
                const result = await reviewsCollections.deleteOne({
                    _id: new ObjectId(id),
                });

                res.status(200).json({ success: true, data: result });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        });
        // user
        app.get('/users/:email', async (req, res) => {
            const email = req.params.email;
            const user = await userCollections.findOne({ email });
            res.status(200).json({ success: true, data: user });
        });
        // Delete review
        app.delete("/reviews/:id", async (req, res) => {
            try {
                const id = req.params.id;
                const result = await reviewsCollections.deleteOne({
                    _id: new ObjectId(id),
                });

                res.status(200).json({ success: true, data: result });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        });
        // Update application status
        app.patch("/applications/:id", async (req, res) => {
            const id = req.params.id;
            const update = req.body;

            try {
                const result = await applicationsCollections.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: update }
                );

                res.status(200).json({ success: true, data: result });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        });
        // Add new scholarship (Admin)
        app.post("/scholarships", async (req, res) => {
            try {
                const scholarship = {
                    ...req.body,
                    postDate: new Date(),
                };

                const result = await scholarshipsCollections.insertOne(scholarship);
                res.status(200).json({ success: true, data: result });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        });
        // Get scholarships (admin list + search + pagination)
        app.get("/admin/scholarships", async (req, res) => {
            let { search = "", page = 1, limit = 10 } = req.query;
            page = parseInt(page) || 1;
            limit = parseInt(limit) || 10;
            const skip = (page - 1) * limit;

            const filter = {};
            if (search) {
                const rgx = new RegExp(search, "i");
                filter.$or = [
                    { scholarship_name: { $regex: rgx } },
                    { university_name: { $regex: rgx } },
                ];
            }

            try {
                const [items, total] = await Promise.all([
                    scholarshipsCollections.find(filter).sort({ postDate: -1, _id: -1 }).skip(skip).limit(limit).toArray(),
                    scholarshipsCollections.countDocuments(filter),
                ]);

                res.status(200).json({
                    success: true,
                    data: items,
                    meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
                });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        });
        // ✅ Update scholarship
        app.patch("/scholarships/:id", async (req, res) => {
            const { id } = req.params;
            const update = req.body;

            try {
                const result = await scholarshipsCollections.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: update }
                );
                res.status(200).json({ success: true, data: result });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        });
        // ✅ Delete scholarship
        app.delete("/scholarships/:id", async (req, res) => {
            const { id } = req.params;

            try {
                const result = await scholarshipsCollections.deleteOne({ _id: new ObjectId(id) });
                res.status(200).json({ success: true, data: result });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        });

        // all user
        app.get("/users", async (req, res) => {
            try {
                let { search = "", page = 1, limit = 10 } = req.query;

                page = parseInt(page) || 1;
                limit = parseInt(limit) || 10;
                const skip = (page - 1) * limit;

                const filter = {};

                if (search && search.trim() !== "") {
                    const regex = new RegExp(search.trim(), "i");
                    filter.$or = [
                        { name: { $regex: regex } },
                        { email: { $regex: regex } },
                    ];
                }

                const [items, total] = await Promise.all([
                    userCollections
                        .find(filter)
                        .sort({ _id: -1 })
                        .skip(skip)
                        .limit(limit)
                        .toArray(),
                    userCollections.countDocuments(filter),
                ]);

                res.status(200).json({
                    success: true,
                    data: items,
                    meta: {
                        total,
                        page,
                        limit,
                        totalPages: Math.ceil(total / limit),
                    },
                });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        });
        // analytics
        app.get("/admin/analytics", verifyFirebaseToken, async (req, res) => {
            try {
                const totalUsers = await userCollections.countDocuments();
                const totalScholarships = await scholarshipsCollections.countDocuments();
                const totalApplications = await applicationsCollections.countDocuments();
                const totalReviews = await reviewsCollections.countDocuments();

                const applicationStats = await applicationsCollections.aggregate([
                    {
                        $group: {
                            _id: "$applicationStatus",
                            count: { $sum: 1 },
                        },
                    },
                ]).toArray();

                res.status(200).json({
                    success: true,
                    data: {
                        totalUsers,
                        totalScholarships,
                        totalApplications,
                        totalReviews,
                        applicationStats,
                    },
                });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        });

        // get reviw
        // ✅ Get reviews (by scholarship OR all)
        app.get("/reviews", async (req, res) => {
            try {
                const { scholarshipId } = req.query;

                const filter = scholarshipId
                    ? { scholarshipId } // string match
                    : {};

                const reviews = await reviewsCollections
                    .find(filter)
                    .sort({ reviewDate: -1 })
                    .toArray();

                res.status(200).json({ success: true, data: reviews });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message });
            }
        });


    } finally {
        // await client.close();
    }
}
run().catch(console.dir);



app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})
