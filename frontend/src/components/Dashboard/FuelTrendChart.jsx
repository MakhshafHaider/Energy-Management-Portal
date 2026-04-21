import React, { useRef, useEffect } from 'react';
import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend, Filler } from 'chart.js';

// Register Chart.js components
Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend, Filler);

const FuelTrendChart = ({ data }) => {
  const chartRef = useRef(null);
  const chartInstance = useRef(null);

  useEffect(() => {
    const ctx = chartRef.current.getContext('2d');

    // Create gradient for the line chart
    const gradient = ctx.createLinearGradient(0, 0, 0, 320);
    gradient.addColorStop(0, 'rgba(234, 88, 12, 0.15)');
    gradient.addColorStop(1, 'rgba(234, 88, 12, 0.01)');

    // Secondary gradient
    const gradient2 = ctx.createLinearGradient(0, 0, 0, 320);
    gradient2.addColorStop(0, 'rgba(34, 197, 94, 0.1)');
    gradient2.addColorStop(1, 'rgba(34, 197, 94, 0.01)');

    // Use API data only - no mock data
    const chartData = data || { labels: [], thisWeek: [], lastWeek: [] };

    const config = {
      type: 'line',
      data: {
        labels: chartData.labels,
        datasets: [
          {
            label: 'This Week',
            data: chartData.thisWeek,
            borderColor: '#ea580c',
            backgroundColor: gradient,
            borderWidth: 2,
            fill: true,
            tension: 0.4,
            pointRadius: 4,
            pointBackgroundColor: '#ea580c',
            pointBorderColor: '#ffffff',
            pointBorderWidth: 2,
            pointHoverRadius: 6,
          },
          {
            label: 'Last Week',
            data: chartData.lastWeek,
            borderColor: '#22c55e',
            backgroundColor: gradient2,
            borderWidth: 2,
            borderDash: [5, 5],
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            pointBackgroundColor: '#22c55e',
            pointBorderColor: '#ffffff',
            pointBorderWidth: 2,
            pointHoverRadius: 5,
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: {
              usePointStyle: true,
              pointStyle: 'circle',
              padding: 20,
              font: {
                family: 'Inter',
                size: 12,
              },
              color: '#6b7280'
            }
          },
          tooltip: {
            backgroundColor: '#1f2937',
            padding: 12,
            titleFont: {
              family: 'Inter',
              size: 13,
              weight: '600'
            },
            bodyFont: {
              family: 'Inter',
              size: 12
            },
            cornerRadius: 8,
            displayColors: false,
            callbacks: {
              label: function(context) {
                return context.dataset.label + ': ' + context.parsed.y.toLocaleString() + ' L';
              }
            }
          }
        },
        scales: {
          x: {
            grid: {
              display: false,
            },
            ticks: {
              font: {
                family: 'Inter',
                size: 12,
              },
              color: '#9ca3af'
            }
          },
          y: {
            beginAtZero: true,
            grid: {
              color: '#f3f4f6',
              drawBorder: false,
            },
            ticks: {
              font: {
                family: 'Inter',
                size: 12,
              },
              color: '#9ca3af',
              callback: function(value) {
                return value.toLocaleString() + 'L';
              }
            }
          }
        },
        interaction: {
          intersect: false,
          mode: 'index'
        }
      }
    };

    chartInstance.current = new Chart(ctx, config);

    // Cleanup on unmount
    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
      }
    };
  }, [data]); // Re-run when data changes

  return (
    <div className="chart-card main-chart">
      <div className="card-header">
        <div className="card-title-section">
          <h3>Fuel Consumption Trend</h3>
          <p>Last 7 Days</p>
        </div>
        <div className="card-actions">
          <button className="btn-sm btn-outline">
            <i className="fas fa-filter"></i>
          </button>
        </div>
      </div>
      <div className="chart-container">
        <canvas ref={chartRef}></canvas>
      </div>
    </div>
  );
};

export default FuelTrendChart;
