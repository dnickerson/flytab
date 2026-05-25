export default {
    test: {
        environment: 'jsdom',
        include: ['tests/**/*.test.js'],
        globals: false,
        coverage: {
            include: ['web/shared/**/*.js'],
            thresholds: {
                lines:    50,
                branches: 50,
            },
            reporter: ['text', 'lcov'],
        },
    },
};
