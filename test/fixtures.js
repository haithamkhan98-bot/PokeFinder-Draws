// Both taken verbatim from embeds posted in the Walmart channel.

export const drawEmbed = {
  author: { name: 'Walmart Draws' },
  title: 'Pokemon TCG: Scarlet & Violet - Prismatic Evolutions 2Pk Booster Bundle',
  fields: [
    { name: 'Price', value: '$79.94' },
    { name: 'Type', value: 'New Product' },
    { name: 'PID', value: '20288667355' },
    { name: 'Time', value: 'Oct 26, 2:00pm - 3:00pm PDT' },
    { name: 'Cart Limit', value: '12' },
    { name: 'Seller', value: 'Walmart.com' },
    { name: 'Links', value: 'Ebay | Ebay Sales | Report Bugs' },
  ],
  thumbnail: { url: 'https://i5.walmartimages.com/asr/ca4f84db-7fc4-4ad2-8048-2667c4aa0b6f.jpeg' },
};

export const restockEmbed = {
  author: { name: 'Walmart US V2' },
  title: 'Magic: The Gathering Final Fantasy Counter Revival Trance Collector Edition',
  fields: [
    { name: 'Price', value: '150.0 USD' },
    { name: 'Type', value: 'Restock' },
    { name: 'PID', value: '15561620611' },
    { name: 'Seller', value: 'Walmart.com' },
    { name: 'Stock', value: ':green_circle:' },
    { name: 'Cart Limit', value: '4' },
    { name: 'Offer Id', value: '46612FB1F21F34DA8BC650A8E689DEFC' },
    { name: 'Copyable Pid', value: '15561620611' },
  ],
  thumbnail: { url: 'https://i5.walmartimages.com/asr/other.jpeg' },
};

// The 21 October draw, five items in one window, as the replay case.
const oct21 = (pid, title, price) => ({
  author: { name: 'Walmart Draws' },
  title,
  fields: [
    { name: 'Price', value: price },
    { name: 'PID', value: pid },
    { name: 'Time', value: 'Oct 21, 2:00pm - 3:00pm PDT' },
  ],
  thumbnail: { url: `https://i5.walmartimages.com/asr/${pid}.jpeg` },
});

export const oct21Draw = [
  oct21('111', 'Pokemon TCG: 30th Celebration Booster Bundle 2-Pack', '$79.94'),
  oct21('222', 'Pokemon TCG: 30th Celebration Knock Out Collection 4-Count Bundle', '$47.92'),
  oct21('333', 'Pokemon TCG: 30th Celebration Pokemon ex Box Bundle', '$69.94'),
  oct21('444', 'Pokemon TCG: Scarlet & Violet Destined Rivals 3Pk Blister 2-Pack Bundle', '$39.97'),
  oct21('555', 'Pokemon TCG: Black Bolt White Flare Unova Poster Collection', '$21.87'),
];
