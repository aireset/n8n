import { parse } from 'flatted';
import type { IDataObject, IPinData, IRunData, IWorkflowExecutionDataProcess } from 'n8n-workflow';
import assert from 'node:assert';
import { Container, Service } from 'typedi';

import { ActiveExecutions } from '@/active-executions';
import type { ExecutionEntity } from '@/databases/entities/execution-entity';
import type { User } from '@/databases/entities/user';
import type { WorkflowEntity } from '@/databases/entities/workflow-entity';
import { ExecutionRepository } from '@/databases/repositories/execution.repository';
import { TestRunRepository } from '@/databases/repositories/test-run.repository';
import { WorkflowRepository } from '@/databases/repositories/workflow.repository';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { TestDefinitionService } from '@/evaluation/test-definition.service.ee';
import type { IExecutionDb, IExecutionResponse } from '@/interfaces';
import { getRunData } from '@/workflow-execute-additional-data';
import { WorkflowRunner } from '@/workflow-runner';

/**
 * This service orchestrates the running of test cases.
 * It uses the test definitions to find
 * past executions, creates pin data from them,
 * and runs the workflow-under-test with the pin data.
 * TODO: Evaluation workflows
 * TODO: Node pinning
 * TODO: Collect metrics
 */
@Service()
export class TestRunnerService {
	constructor(
		private readonly testDefinitionsService: TestDefinitionService,
		private readonly workflowRepository: WorkflowRepository,
		private readonly workflowRunner: WorkflowRunner,
		private readonly executionRepository: ExecutionRepository,
		private readonly testRunRepository: TestRunRepository,
	) {}

	/**
	 * Creates a pin data object from the past execution data
	 * for the given workflow.
	 * For now, it only pins trigger nodes.
	 * @param workflow
	 * @param execution
	 * @private
	 */
	private createPinDataFromExecution(workflow: WorkflowEntity, execution: ExecutionEntity) {
		const executionData = parse(execution.executionData.data) as IExecutionResponse['data'];

		const triggerNodes = workflow.nodes.filter((node) => /trigger$/i.test(node.type));

		const pinData = {} as IPinData;

		for (const triggerNode of triggerNodes) {
			const triggerData = executionData.resultData.runData[triggerNode.name];
			if (triggerData?.[0]?.data?.main?.[0]) {
				pinData[triggerNode.name] = triggerData[0]?.data?.main?.[0];
			}
		}

		return { pinData, executionData };
	}

	/**
	 * Runs a test case with the given pin data.
	 * Waits for the workflow under test to finish execution.
	 * @param workflow
	 * @param testCase
	 * @param userId
	 * @private
	 */
	private async runTestCase(
		workflow: WorkflowEntity,
		testCase: IPinData,
		userId: string,
	): Promise<IExecutionDb | undefined> {
		// Prepare the data to run the workflow
		const data: IWorkflowExecutionDataProcess = {
			executionMode: 'evaluation',
			runData: {},
			pinData: testCase,
			workflowData: workflow,
			partialExecutionVersion: '-1',
			userId,
		};

		// Trigger the workflow under test with mocked data
		const executionId = await this.workflowRunner.run(data);
		assert(executionId);

		// Wait for the execution to finish
		const executePromise = Container.get(ActiveExecutions).getPostExecutePromise(
			executionId,
		) as Promise<IExecutionDb | undefined>;

		return await executePromise;
	}

	/**
	 * Run the evaluation workflow with the expected and actual run data.
	 * @param evaluationWorkflow
	 * @param expectedData
	 * @param actualData
	 * @private
	 */
	private async runTestCaseEvaluation(
		evaluationWorkflow: WorkflowEntity,
		expectedData: IRunData,
		actualData: IRunData,
	) {
		// Prepare the evaluation wf input data.
		// Provide both the expected data and the actual data
		const evaluationInputData = {
			json: {
				originalExecution: expectedData,
				newExecution: actualData,
			},
		};

		// Prepare the data to run the evaluation workflow
		const data = await getRunData(evaluationWorkflow, [evaluationInputData]);

		// Trigger the evaluation workflow
		const executionId = await this.workflowRunner.run(data);
		assert(executionId);

		// Wait for the execution to finish
		const executePromise = Container.get(ActiveExecutions).getPostExecutePromise(
			executionId,
		) as Promise<IExecutionDb | undefined>;

		return await executePromise;
	}

	private extractEvaluationResult(execution: IExecutionDb): IDataObject {
		const lastNodeExecuted = execution.data.resultData.lastNodeExecuted;
		assert(lastNodeExecuted, 'Could not find the last node executed in evaluation workflow');

		// Extract the output of the last node executed in the evaluation workflow
		// We use only the first main output
		return execution.data.resultData.runData[lastNodeExecuted]?.[0]?.data?.main[0]?.[0]?.json ?? {};
	}

	/**
	 * Creates a new test run for the given test definition.
	 * @param user
	 * @param testId
	 * @param accessibleWorkflowIds
	 */
	public async runTest(user: User, testId: string, accessibleWorkflowIds: string[]): Promise<any> {
		const test = await this.testDefinitionsService.findOne(testId, accessibleWorkflowIds);

		if (!test) {
			throw new NotFoundError('Test definition not found');
		}

		const workflow = await this.workflowRepository.findById(test.workflowId);
		assert(workflow, 'Workflow not found');

		const evaluationWorkflow = await this.workflowRepository.findById(test.evaluationWorkflowId);
		assert(evaluationWorkflow, 'Evaluation workflow not found');

		// 0. Create new Test Run
		const testRun = this.testRunRepository.create({
			testDefinition: { id: test.id },
			status: 'new',
		});

		await this.testRunRepository.save(testRun);

		// 1. Make test cases from previous executions

		// Select executions with the annotation tag and workflow ID of the test.
		// Join with the execution data and metadata
		const executions = await this.executionRepository
			.createQueryBuilder('execution')
			.leftJoin('execution.annotation', 'annotation')
			.leftJoin('annotation.tags', 'annotationTag')
			.leftJoinAndSelect('execution.executionData', 'executionData')
			.leftJoinAndSelect('execution.metadata', 'metadata')
			.where('annotationTag.id = :tagId', { tagId: test.annotationTagId })
			.andWhere('execution.workflowId = :workflowId', { workflowId: test.workflowId })
			.getMany();

		const testCases = executions.map((execution) =>
			this.createPinDataFromExecution(workflow, execution),
		);

		// 2. Run over all the test cases

		testRun.status = 'running';
		testRun.runAt = new Date();
		await this.testRunRepository.save(testRun);

		const metrics = [];

		for (const testCase of testCases) {
			const { pinData, executionData } = testCase;

			// Run the test case and wait for it to finish
			const execution = await this.runTestCase(workflow, pinData, user.id);

			// TODO: handle the case where the execution fails

			if (!execution) {
				continue;
			}

			// Collect the results of the test case execution
			const testCaseRunData = execution.data.resultData.runData;

			// Get the original runData from the test case execution data
			const originalRunData = executionData.resultData.runData;

			// Run the evaluation workflow with the original and new run data
			const evalExecution = await this.runTestCaseEvaluation(
				evaluationWorkflow,
				originalRunData,
				testCaseRunData,
			);
			assert(evalExecution);

			// Extract the output of the last node executed in the evaluation workflow
			const evalResult = this.extractEvaluationResult(evalExecution);
			console.log({ evalResult });

			// TODO: collect metrics
			metrics.push(evalResult);
		}

		// TODO: 3. Aggregate the results
		// Now we just set success to true if all the test cases passed
		const aggregatedMetrics = { success: metrics.every((metric) => metric.success) };

		testRun.status = 'completed';
		testRun.completedAt = new Date();
		testRun.metrics = aggregatedMetrics;
		await this.testRunRepository.save(testRun);

		return { success: true };
	}
}
