import { randomUUID } from 'node:crypto';

/**
 * @typedef {{ title?: string, artist?: string, album?: string, artwork?: string } & Record<string, any>} MetadataPayload
 * @typedef {{ statusCode: number, headers: Record<string, string>, body: string }} LambdaResponse
 * @type {(event: { queryStringParameters?: Record<string, string> }) => Promise<LambdaResponse>}
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export const handler = async event => {
    const metadata = [
        {
            album: 'Abbey Road',
            artist: 'The Beatles',
            title: 'Here Comes the Sun',
            artwork: 'https://placehold.co/1200.jpg?text=Here+Comes+the+Sun',
        },
        {
            album: 'Back in Black',
            artist: 'AC/DC',
            title: 'Back in Black',
            artwork: 'https://placehold.co/1200.jpg?text=Back+in+Black',
        },
        {
            album: 'Bad Romance',
            artist: 'Lady Gaga',
            title: 'Bad Romance',
            artwork: 'https://placehold.co/1200.jpg?text=Bad+Romance',
        },
        {
            album: 'Blonde',
            artist: 'Frank Ocean',
            title: 'Good Guy',
            artwork: 'https://placehold.co/1200.jpg?text=Good+Guy',
        },
        {
            album: 'Born to Run',
            artist: 'Bruce Springsteen',
            title: 'Born to Run',
            artwork: 'https://placehold.co/1200.jpg?text=Born+to+Run',
        },
        {
            album: 'Fearless',
            artist: 'Taylor Swift',
            title: 'Teardrops on My Guitar',
            artwork: 'https://placehold.co/1200.jpg?text=Teardrops+on+My+Guitar',
        },
        {
            album: 'good kid, m.A.A.d city',
            artist: 'Kendrick Lamar',
            title: "Bitch Don't Kill My Vibe",
            artwork: "https://placehold.co/1200.jpg?text=Bitch+Don't+Kill+My+Vibe",
        },
        {
            album: 'In the Court of the Crimson King',
            artist: 'King Crimson',
            title: '21st Century Schizoid Man',
            artwork: 'https://placehold.co/1200.jpg?text=21st+Century+Schizoid+Man',
        },
        {
            album: 'London Calling',
            artist: 'The Clash',
            title: 'London Calling',
            artwork: 'https://placehold.co/1200.jpg?text=London+Calling',
        },
        {
            album: 'Meddle',
            artist: 'Pink Floyd',
            title: 'One of These Days',
            artwork: 'https://placehold.co/1200.jpg?text=One+of+These+Days',
        },
        {
            album: 'Nevermind',
            artist: 'Nirvana',
            title: 'Smells Like Teen Spirit',
            artwork: 'https://placehold.co/1200.jpg?text=Smells+Like+Teen+Spirit',
        },
        {
            album: 'Pet Sounds',
            artist: 'The Beach Boys',
            title: "Wouldn't It Be Nice",
            artwork: "https://placehold.co/1200.jpg?text=Wouldn't+It+Be+Nice",
        },
        {
            album: 'Purple Rain',
            artist: 'Prince',
            title: 'Purple Rain',
            artwork: 'https://placehold.co/1200.jpg?text=Purple+Rain',
        },
        {
            album: 'Rumours',
            artist: 'Fleetwood Mac',
            title: 'Dreams',
            artwork: 'https://placehold.co/1200.jpg?text=Dreams',
        },
        {
            album: "Sgt. Pepper's Lonely Hearts Club Band",
            artist: 'The Beatles',
            title: 'A Day in the Life',
            artwork: 'https://placehold.co/1200.jpg?text=A+Day+in+the+Life',
        },
        {
            album: 'Songs in the Key of Life',
            artist: 'Stevie Wonder',
            title: 'Living for the City',
            artwork: 'https://placehold.co/1200.jpg?text=Living+for+the+City',
        },
        {
            album: 'Super freak',
            artist: 'Rick Astley',
            title: 'Never Gonna Give You Up',
            artwork: 'https://placehold.co/1200.jpg?text=Never+Gonna+Give+You+Up',
        },
        {
            album: 'The Blueprint',
            artist: 'Jay-Z',
            title: '99 Problems',
            artwork: 'https://placehold.co/1200.jpg?text=99+Problems',
        },
        {
            album: 'The Dark Side of the Moon',
            artist: 'Pink Floyd',
            title: 'Money',
            artwork: 'https://placehold.co/1200.jpg?text=Money',
        },
        {
            album: 'The Day Is Gone',
            artist: 'Miles Davis',
            title: 'All Blues',
            artwork: 'https://placehold.co/1200.jpg?text=All+Blues',
        },
        {
            album: 'The Joshua Tree',
            artist: 'U2',
            title: 'Where the Streets Have No Name',
            artwork: 'https://placehold.co/1200.jpg?text=Where+the+Streets+Have+No+Name',
        },
        {
            album: 'The Miseducation of Lauryn Hill',
            artist: 'Lauryn Hill',
            title: 'Everything Is Everything',
            artwork: 'https://placehold.co/1200.jpg?text=Everything+Is+Everything',
        },
        {
            album: 'The Sound of Silence',
            artist: 'Simon & Garfunkel',
            title: 'The Sound of Silence',
            artwork: 'https://placehold.co/1200.jpg?text=The+Sound+of+Silence',
        },
        {
            album: 'The Velvet Underground & Nico',
            artist: 'The Velvet Underground',
            title: 'Pale Blue Eyes',
            artwork: 'https://placehold.co/1200.jpg?text=Pale+Blue+Eyes',
        },
        {
            album: 'The Wall',
            artist: 'Pink Floyd',
            title: 'Another Brick in the Wall',
            artwork: 'https://placehold.co/1200.jpg?text=Another+Brick+in+the+Wall',
        },
        {
            album: 'Thriller',
            artist: 'Michael Jackson',
            title: 'Thriller',
            artwork: 'https://placehold.co/1200.jpg?text=Thriller',
        },
    ];

    const otherData = {
        otherDataNumber: Math.floor(Math.random() * 1000000),
        otherDataText: randomUUID(),
    };

    /** @type {MetadataPayload} */
    let body = metadata[Math.floor(Math.random() * metadata.length)];

    if (event.queryStringParameters?.includeOtherData === '1') {
        body = { ...body, ...otherData };
    }

    /** @type {LambdaResponse} */
    const response = {
        statusCode: 200,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
        },
        body: JSON.stringify(body),
    };

    return response;
};
