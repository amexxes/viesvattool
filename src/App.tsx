// Moved maxCount calculation outside the style function
const maxCount = Math.max(...data.map(item => item.count));

// Helper function to determine fill color based on count
const getFillColor = (count) => {
    const colorScale = d3.scaleSequential(d3.interpolateYlOrRd).domain([0, maxCount]);
    return colorScale(count);
};

// Update style to use the getFillColor helper function
const style = (count) => ({
    fill: getFillColor(count),
    stroke: '#000',
    strokeWidth: 2,
});

// ...rest of your component implementation