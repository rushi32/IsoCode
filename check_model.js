const axios = require('axios');

async function checkModel() {
    try {
        const response = await axios.get('http://localhost:1234/v1/models');
        console.log("Models:", JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error("Error fetching models:", error.message);
    }
}

checkModel();
