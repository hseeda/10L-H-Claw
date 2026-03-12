require('dotenv').config();

/**
 * Posts a message to a Facebook Page using the Graph API.
 * @param {string} message - The text content of the post.
 * @param {string} link - Optional link to include in the post.
 * @returns {Promise<Object>} - The JSON response from the Facebook API.
 */
async function postToPage(message, link = null) {
    const pageId = process.env.FACEBOOK_PAGE_ID;
    const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

    if (!pageId || !accessToken) {
        throw new Error('FACEBOOK_PAGE_ID or FACEBOOK_PAGE_ACCESS_TOKEN is missing in .env');
    }

    const url = `https://graph.facebook.com/v21.0/${pageId}/feed`;
    
    const body = {
        message: message,
        access_token: accessToken
    };

    if (link) {
        body.link = link;
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('Facebook API Error:', data);
            throw new Error(data.error?.message || 'Failed to post to Facebook Page');
        }

        console.log('Successfully posted to Facebook Page:', data.id);
        return data;
    } catch (error) {
        console.error('Error posting to Facebook:', error.message);
        throw error;
    }
}

module.exports = {
    postToPage
};
