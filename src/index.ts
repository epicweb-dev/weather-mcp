/// <reference path="../types/worker-configuration.d.ts" />

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpAgent } from 'agents/mcp'
import { z } from 'zod'

const weatherResultSchema = z.object({
	current: z.object({
		temperature_2m: z.number(),
		relative_humidity_2m: z.number(),
		wind_speed_10m: z.number(),
		weather_code: z.number(),
	}),
})

const nominatimResponseSchema = z.object({
	address: z
		.object({
			city: z.string().optional(),
			town: z.string().optional(),
			village: z.string().optional(),
			country: z.string().optional(),
		})
		.optional(),
})

// Helper function to get location details from coordinates
async function reverseGeocode(latitude: number, longitude: number) {
	const response = await fetch(
		`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`,
		{
			headers: {
				'User-Agent': 'Weather MCP Tool/1.0',
			},
		},
	)
	const data = nominatimResponseSchema.parse(await response.json())
	return {
		city:
			data.address?.city ||
			data.address?.town ||
			data.address?.village ||
			'Unknown location',
		country: data.address?.country || 'Unknown country',
	}
}

// Helper function to convert Celsius to Fahrenheit
function celsiusToFahrenheit(celsius: number): number {
	return (celsius * 9) / 5 + 32
}

export class WeatherMCP extends McpAgent<Env> {
	server = new McpServer(
		{
			name: 'Weather',
			version: '1.0.0',
		},
		{
			instructions: `
Weather is a tool that allows users to get the weather of a given latitude and longitude.
			`.trim(),
		},
	)

	async init() {
		this.server.tool(
			'getWeather',
			'Get the weather of a given latitude and longitude.',
			{
				latitude: z.coerce.number(),
				longitude: z.coerce.number(),
				unit: z
					.enum(['celsius', 'fahrenheit'])
					.optional()
					.default('fahrenheit'),
			},
			async ({ latitude, longitude, unit }) => {
				try {
					// First get location details
					const { city, country } = await reverseGeocode(latitude, longitude)

					// Then get weather data using those coordinates
					const weatherResponse = await fetch(
						`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`,
					)
					const weatherJson = await weatherResponse.json()
					const weatherData = weatherResultSchema.parse(weatherJson)

					if (!weatherData?.current) {
						return {
							isError: true,
							content: [
								{
									type: 'text',
									text: 'Weather data not available or invalid API response',
								},
							],
						}
					}

					// Convert temperature if needed
					const temperature =
						unit === 'fahrenheit'
							? celsiusToFahrenheit(weatherData.current.temperature_2m)
							: weatherData.current.temperature_2m

					// Convert weather code to description
					const weatherDescription = getWeatherDescription(
						weatherData.current.weather_code,
					)

					return {
						content: [
							{
								type: 'text',
								text: `
Weather in ${city}, ${country}:
• Temperature: ${temperature.toFixed(1)}°${unit === 'fahrenheit' ? 'F' : 'C'}
• Humidity: ${weatherData.current.relative_humidity_2m}%
• Wind Speed: ${weatherData.current.wind_speed_10m} km/h
• Conditions: ${weatherDescription}
								`.trim(),
							},
						],
					}
				} catch (error) {
					return {
						isError: true,
						content: [{ type: 'text', text: getErrorMessage(error) }],
					}
				}
			},
		)
	}
}

// Helper function to convert WMO weather codes to descriptions
function getWeatherDescription(code: number): string {
	const weatherCodes: Record<number, string> = {
		0: 'Clear sky',
		1: 'Mainly clear',
		2: 'Partly cloudy',
		3: 'Overcast',
		45: 'Foggy',
		48: 'Depositing rime fog',
		51: 'Light drizzle',
		53: 'Moderate drizzle',
		55: 'Dense drizzle',
		56: 'Light freezing drizzle',
		57: 'Dense freezing drizzle',
		61: 'Slight rain',
		63: 'Moderate rain',
		65: 'Heavy rain',
		66: 'Light freezing rain',
		67: 'Heavy freezing rain',
		71: 'Slight snow fall',
		73: 'Moderate snow fall',
		75: 'Heavy snow fall',
		77: 'Snow grains',
		80: 'Slight rain showers',
		81: 'Moderate rain showers',
		82: 'Violent rain showers',
		85: 'Slight snow showers',
		86: 'Heavy snow showers',
		95: 'Thunderstorm',
		96: 'Thunderstorm with slight hail',
		99: 'Thunderstorm with heavy hail',
	}
	return weatherCodes[code] || 'Unknown'
}

function getErrorMessage(error: unknown) {
	if (typeof error === 'string') return error
	if (
		error &&
		typeof error === 'object' &&
		'message' in error &&
		typeof error.message === 'string'
	) {
		return error.message
	}
	console.error('Unable to get error message for error', error)
	return 'Unknown Error'
}

export default WeatherMCP.mount('/mcp', {
	binding: 'WEATHER_MCP_OBJECT',
})
