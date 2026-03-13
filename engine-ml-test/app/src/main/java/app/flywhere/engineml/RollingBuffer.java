package app.flywhere.engineml;

/**
 * Thread-safe circular buffer for 60-sample sliding window of engine data.
 * Each sample has N_FEATURES float values.
 */
public class RollingBuffer {
    private final int windowSize;
    private final int nFeatures;
    private final float[][] buffer;
    private int writeIndex = 0;
    private int count = 0;

    public RollingBuffer(int windowSize, int nFeatures) {
        this.windowSize = windowSize;
        this.nFeatures = nFeatures;
        this.buffer = new float[windowSize][nFeatures];
    }

    public synchronized void addSample(float[] features) {
        if (features.length != nFeatures) {
            throw new IllegalArgumentException("Expected " + nFeatures + " features, got " + features.length);
        }
        System.arraycopy(features, 0, buffer[writeIndex], 0, nFeatures);
        writeIndex = (writeIndex + 1) % windowSize;
        if (count < windowSize) count++;
    }

    public synchronized boolean isFull() {
        return count >= windowSize;
    }

    public synchronized int getCount() {
        return count;
    }

    /**
     * Returns the current window as a (windowSize, nFeatures) array in chronological order.
     * Returns null if buffer is not yet full.
     */
    public synchronized float[][] getWindow() {
        if (count < windowSize) return null;
        float[][] window = new float[windowSize][nFeatures];
        for (int i = 0; i < windowSize; i++) {
            int idx = (writeIndex + i) % windowSize;
            System.arraycopy(buffer[idx], 0, window[i], 0, nFeatures);
        }
        return window;
    }

    public synchronized void clear() {
        writeIndex = 0;
        count = 0;
    }
}
